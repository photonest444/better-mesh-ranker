/*!
 * Mesh Ranker — ядро работы с API МЭШ (school.mos.ru).
 *
 * Здесь живёт вся «предметная» логика: адреса методов, заголовки, разбор ответов,
 * поиск токена в ответах страницы входа, автоматическое обновление токена.
 * Файл используется как общий источник правды для desktop-версии (Electron),
 * тестов и web-режима. Android-версия повторяет этот же протокол в MeshCore.kt.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./lib/util.js'), require('./lib/stats.js'), require('./lib/format.js'), require('./lib/table.js'));
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    root.MeshCore = factory(lib.util, lib.stats, lib.format, lib.table);
  }
})(typeof self !== 'undefined' ? self : this, function (util, stats, format, table) {
  'use strict';

  var HOST = 'https://school.mos.ru';
  var WEB_HOST = 'https://school.mos.ru';

  var PATHS = {
    /** Профиль родителя + список детей (отдаёт id ученика и contingent_guid). */
    profile: '/api/family/web/v1/profile',
    /** Имя ученика по personId. */
    profileById: '/api/gamification/v1/profiles',
    /** Предметы с местами и средними баллами. */
    subjects: '/api/ej/rating/v1/rank/subjects',
    /** Рейтинг класса (общий или по предмету). */
    rank: '/api/ej/rating/v1/rank/class',
    /** Оценки за период. */
    marks: '/api/family/web/v1/marks',
    /** Итоговые оценки по предметам. */
    subjectMarks: '/api/family/web/v1/subject_marks',
    /** Домашние задания за период. */
    homeworks: '/api/family/web/v1/homeworks',
    /** Расписание на дату. */
    schedule: '/api/family/web/v1/schedule',
    /** Обновление токена. */
    tokenRefresh: '/v2/token/refresh',
    /** Данные об учётной записи. */
    userInfo: '/v3/userinfo'
  };

  var ROLE_ID = '1';
  var SUBSYSTEM = 'familyweb';
  var SUBSYSTEM_ID = '2';
  var PROFILE_TYPE = 'student';

  /** Страница, после входа на которой МЭШ отдаёт свежий токен. */
  function loginUrl() {
    return WEB_HOST + PATHS.tokenRefresh + '?roleId=' + ROLE_ID + '&subsystem=' + SUBSYSTEM_ID;
  }

  var USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36';

  // ------------------------------------------------------------------ Ошибки --

  function MeshError(message, options) {
    var opts = options || {};
    this.name = 'MeshError';
    this.message = message;
    this.code = opts.code || 'error';
    this.status = opts.status || 0;
    this.cause = opts.cause || null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, MeshError);
    else this.stack = new Error(message).stack;
  }
  MeshError.prototype = Object.create(Error.prototype);
  MeshError.prototype.constructor = MeshError;

  /** Человеческое описание ошибки для интерфейса. */
  function describeError(error) {
    if (!error) return 'Неизвестная ошибка';
    if (error.code === 'network') return 'Нет связи с school.mos.ru. Проверьте интернет и попробуйте ещё раз.';
    if (error.code === 'timeout') return 'Сервер МЭШ не ответил вовремя. Попробуйте ещё раз.';
    if (error.code === 'unauthorized') return 'Токен недействителен или истёк. Выполните вход в МЭШ заново.';
    if (error.code === 'forbidden') return 'Нет доступа к данным (403). Возможно, нужен вход под ролью родителя.';
    if (error.code === 'not-found') return 'Метод недоступен для вашего региона или подсистемы (404).';
    if (error.code === 'invalid-json') return 'МЭШ вернул неожиданный ответ. Возможно, требуется повторный вход.';
    if (error.code && error.code.indexOf('http-') === 0) return 'Ошибка сервера МЭШ (' + error.status + '). Попробуйте позже.';
    return error.message || String(error);
  }

  // ------------------------------------------------------------- Заголовки ---

  function baseHeaders() {
    return {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9',
      'Content-Type': 'application/json;charset=UTF-8',
      'Profile-Type': PROFILE_TYPE,
      'User-Agent': USER_AGENT,
      'X-Mes-RoleId': ROLE_ID,
      'X-Mes-Subsystem': SUBSYSTEM
    };
  }

  /** Полный набор заголовков авторизации: МЭШ понимает и Authorization, и Auth-Token. */
  function authHeaders(token, profileId) {
    var headers = {};
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
      headers['Auth-Token'] = token;
    }
    if (profileId) headers['Profile-Id'] = String(profileId);
    return headers;
  }

  // ---------------------------------------------------------------- Токен ----

  var TOKEN_KEY_RE = /^(token|access_token|accessToken|auth_token|authToken|auth-token|bearer|jwt)$/i;
  var JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
  var OPAQUE_RE = /^[A-Za-z0-9._~+/=-]{24,}$/;

  /** Похоже ли значение на токен МЭШ (JWT или длинная случайная строка). */
  function looksLikeToken(value) {
    if (typeof value !== 'string') return false;
    var s = value.trim();
    if (s.length < 20 || /\s/.test(s)) return false;
    if (JWT_RE.test(s)) return true;
    return OPAQUE_RE.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s);
  }

  /** Ищет токен в любом JSON-объекте по «говорящим» ключам. */
  function extractTokenFromObject(data, depth) {
    if (!data || depth > 6) return null;
    if (typeof data === 'string') return looksLikeToken(data) ? data.trim() : null;
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var found = extractTokenFromObject(data[i], (depth || 0) + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof data === 'object') {
      var keys = Object.keys(data);
      for (var k = 0; k < keys.length; k++) {
        if (TOKEN_KEY_RE.test(keys[k]) && looksLikeToken(data[keys[k]])) return String(data[keys[k]]).trim();
      }
      for (var j = 0; j < keys.length; j++) {
        var nested = extractTokenFromObject(data[keys[j]], (depth || 0) + 1);
        if (nested) return nested;
      }
    }
    return null;
  }

  /** Ищет токен в тексте (JSON, HTML, обычная строка). */
  function extractTokenFromText(text) {
    if (!text) return null;
    var s = String(text).trim();
    if (!s) return null;
    // 1) тело целиком — это токен
    if (looksLikeToken(s)) return s;
    // 2) JSON или HTML с ключами token/access_token/...
    try {
      var parsed = JSON.parse(s);
      var fromJson = extractTokenFromObject(parsed, 0);
      if (fromJson) return fromJson;
    } catch (e) { /* не JSON — это нормально */ }
    var keyed = new RegExp('"(?:token|access_token|accessToken|auth_token|authToken)"\\s*[:=]\\s*"([^"]{16,})"', 'i').exec(s);
    if (keyed && looksLikeToken(keyed[1])) return keyed[1];
    var jwt = JWT_RE.exec(s);
    if (jwt) return jwt[0];
    return null;
  }

  /** Ищет токен в URL (query или hash): ...?token=... , #access_token=... */
  function extractTokenFromUrl(url) {
    if (!url) return null;
    var s = String(url);
    var patterns = [
      /[?#&]token=([^&#\s]+)/i,
      /[?#&]access_token=([^&#\s]+)/i,
      /[?#&]auth_token=([^&#\s]+)/i
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = patterns[i].exec(s);
      if (m) {
        var value = decodeURIComponent(m[1]);
        if (looksLikeToken(value)) return value;
        var nested = extractTokenFromText(value);
        if (nested) return nested;
      }
    }
    // токен может лежать целиком в hash (#<token>)
    if (s.indexOf('#') >= 0) {
      var hash = s.slice(s.indexOf('#') + 1);
      if (looksLikeToken(hash)) return hash.trim();
    }
    return null;
  }

  /** Универсальный поиск токена: сначала объект, потом текст, потом URL. */
  function extractToken(source) {
    if (!source) return null;
    if (typeof source === 'object') return extractTokenFromObject(source, 0);
    var text = String(source);
    var fromUrl = extractTokenFromUrl(text);
    if (fromUrl) return fromUrl;
    return extractTokenFromText(text);
  }

  /**
   * «Мягкий» поиск токена для демо-режима: мок-сервер отдаёт короткие токены
   * вида mock-token-2, которые не проходят строгую проверку формата.
   */
  function extractLooseToken(text) {
    if (!text) return null;
    var s = String(text).trim();
    try {
      var parsed = JSON.parse(s);
      if (parsed && typeof parsed.token === 'string' && parsed.token) return parsed.token;
    } catch (error) { /* не JSON */ }
    var match = /"token"\s*:\s*"([^"]+)"/i.exec(s);
    return match ? match[1] : null;
  }

  /** Разбор JWT-полезной нагрузки без проверки подписи (только для отображения). */
  function decodeJwt(token) {
    if (!token) return null;
    var parts = String(token).split('.');
    if (parts.length < 2) return null;
    try {
      var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      var json = typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString('binary');
      var utf8 = decodeURIComponent(json.split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(utf8);
    } catch (e) {
      return null;
    }
  }

  /** Сведения о токене для экрана «Профиль»: тип, срок действия, маска. */
  function describeToken(token) {
    if (!token) return { present: false, kind: 'none', mask: '—', expiresAt: null, issuedAt: null, subjects: null };
    var jwt = decodeJwt(token);
    var info = {
      present: true,
      kind: jwt ? 'jwt' : 'opaque',
      mask: maskToken(token),
      expiresAt: jwt && jwt.exp ? Number(jwt.exp) * 1000 : null,
      issuedAt: jwt && jwt.iat ? Number(jwt.iat) * 1000 : null,
      subjects: jwt && jwt.sub ? jwt.sub : null,
      length: token.length
    };
    info.expired = info.expiresAt ? info.expiresAt < Date.now() : false;
    return info;
  }

  /** "abcdef…yz12" — токен показываем только частично. */
  function maskToken(token) {
    var s = util.asStr(token);
    if (s.length <= 12) return s.replace(/./g, '•');
    return s.slice(0, 6) + '…' + s.slice(-4);
  }

  // ------------------------------------------------------------- Результаты --

  function personName(last, first, middle) {
    return [last, first, middle].filter(function (part) { return !util.isBlank(part); }).map(function (part) {
      return String(part).trim();
    }).join(' ');
  }

  function normalizeChild(child) {
    var raw = child || {};
    return {
      id: util.asStr(util.firstDefined(raw.id, raw.user_id, raw.student_id, '')),
      personId: util.asStr(util.firstDefined(raw.contingent_guid, raw.person_id, raw.personId, '')),
      name: personName(util.firstDefined(raw.last_name, raw.lastName, ''), util.firstDefined(raw.first_name, raw.firstName, ''), util.firstDefined(raw.middle_name, raw.middleName, '')) || util.asStr(util.firstDefined(raw.name, 'Ученик')),
      shortName: util.asStr(util.firstDefined(raw.first_name, raw.firstName, '')) || util.asStr(util.firstDefined(raw.name, 'Ученик')),
      classId: util.asStr(util.firstDefined(raw.class_id, raw.classId, '')),
      className: util.asStr(util.firstDefined(raw.class_name, raw.className, '')),
      schoolId: util.asStr(util.firstDefined(raw.school_id, raw.schoolId, '')),
      schoolName: util.asStr(util.firstDefined(raw.school_name, raw.schoolName, '')),
      avatarUrl: util.asStr(util.firstDefined(raw.avatar_url, raw.avatarUrl, '')),
      raw: raw
    };
  }

  /** Разбор ответа /api/family/web/v1/profile. */
  function normalizeProfile(data) {
    var raw = data || {};
    var profile = raw.profile || {};
    var children = (raw.children || []).map(normalizeChild);
    return {
      parent: {
        id: util.asStr(util.firstDefined(profile.id, profile.user_id, '')),
        name: personName(util.firstDefined(profile.last_name, ''), util.firstDefined(profile.first_name, ''), util.firstDefined(profile.middle_name, '')) || 'Родитель',
        email: util.asStr(util.firstDefined(profile.email, '')),
        phone: util.asStr(util.firstDefined(profile.phone, profile.mobile_phone, ''))
      },
      children: children,
      defaultChild: children[0] || null,
      hash: util.asStr(raw.hash),
      raw: raw
    };
  }

  /** Предмет + рейтинг ученика по нему. */
  function normalizeSubject(subject) {
    var raw = subject || {};
    var rank = raw.rank || {};
    var average = util.asNum(util.firstDefined(rank.averageMarkFive, raw.averageMarkFive, raw.average_mark, null));
    return {
      id: util.asStr(util.firstDefined(raw.subjectId, raw.subject_id, raw.id, '')),
      name: util.asStr(util.firstDefined(raw.subjectName, raw.subject_name, raw.name, 'Предмет')),
      average: average,
      place: util.asInt(util.firstDefined(rank.rankPlace, rank.place, raw.rankPlace, null)),
      status: util.asStr(util.firstDefined(rank.rankStatus, '')),
      trend: util.asStr(util.firstDefined(rank.trend, '')),
      isExam: util.asBool(util.firstDefined(raw.isExam, raw.is_exam, false)),
      raw: raw
    };
  }

  /**
   * Строка рейтинга класса.
   * API отдаёт: {personId, imageId, rank:{averageMarkFive, rankPlace, rankStatus, trend},
   *              previousRank:{averageMarkFive, rankPlace}}
   */
  function normalizeRankMember(member, index) {
    var raw = member || {};
    var rank = raw.rank || {};
    var previous = raw.previousRank || raw.previous_rank || {};
    var average = util.asNum(util.firstDefined(rank.averageMarkFive, rank.average_mark, raw.averageMarkFive, null));
    var previousAverage = util.asNum(util.firstDefined(previous.averageMarkFive, previous.average_mark, null));
    var place = util.asInt(util.firstDefined(rank.rankPlace, rank.place, null));
    var previousPlace = util.asInt(util.firstDefined(previous.rankPlace, previous.place, null));
    return {
      index: index,
      personId: util.asStr(util.firstDefined(raw.personId, raw.person_id, '')),
      imageId: util.asStr(util.firstDefined(raw.imageId, raw.image_id, '')),
      place: place === null ? index + 1 : place,
      average: average,
      status: util.asStr(util.firstDefined(rank.rankStatus, '')),
      trend: util.asStr(util.firstDefined(rank.trend, '')),
      previousPlace: previousPlace,
      previousAverage: previousAverage,
      placeDelta: previousPlace === null || place === null ? null : previousPlace - place,
      averageDelta: previousAverage === null || average === null ? null : util.round(average - previousAverage, 2),
      raw: raw
    };
  }

  /**
   * Полноценная таблица рейтинга: добавляет имена, флаг «это я», позицию,
   * сортировку по месту и «дельту» относительно предыдущего периода.
   */
  function buildRankTable(members, options) {
    var opts = options || {};
    var names = opts.names || {};
    var meId = util.asStr(opts.meId || '');
    var rows = (members || []).map(function (member, index) { return normalizeRankMember(member, index); });
    rows.forEach(function (row) {
      row.name = util.asStr(names[row.personId]) || shortId(row.personId);
      row.isMe = !!meId && util.asStr(row.personId) === meId;
      row.color = stats.gradeColor(row.average);
      row.trendDirection = util.firstDefined(row.placeDelta, null) !== null
        ? (row.placeDelta > 0 ? 1 : (row.placeDelta < 0 ? -1 : 0))
        : stats.trendDirection(row.average, row.previousAverage);
      row.rankLabel = row.place ? '#' + row.place : '—';
    });
    rows.sort(function (a, b) {
      var ap = a.place === null ? 1e9 : a.place;
      var bp = b.place === null ? 1e9 : b.place;
      if (ap !== bp) return ap - bp;
      return (b.average || 0) - (a.average || 0);
    });
    return rows;
  }

  function shortId(personId) {
    var s = util.asStr(personId);
    if (!s) return 'Неизвестный ученик';
    return 'Ученик ' + s.slice(0, 8);
  }

  /** Сводка по рейтингу класса — карточки в шапке страницы. */
  function summarizeRank(rows, meId) {
    var list = rows || [];
    var averages = stats.values(list, function (row) { return row.average; }).sort(function (a, b) { return b - a; });
    var me = list.filter(function (row) { return row.isMe; })[0] || null;
    var leader = list[0] || null;
    var next = null;
    if (me) {
      var below = list.filter(function (row) { return row.place < me.place; });
      next = below[below.length - 1] || null;
    }
    var places = list.map(function (row) { return row.place; }).filter(function (p) { return p !== null; });
    return {
      total: list.length,
      withMarks: averages.length,
      classAverage: util.round(stats.mean(averages), 2),
      classMedian: util.round(stats.median(averages), 2),
      classMin: stats.min(averages),
      classMax: stats.max(averages),
      myAverage: me ? me.average : null,
      myPlace: me ? me.place : null,
      myRow: me,
      myTrend: me ? me.trendDirection : 0,
      myDelta: me ? me.averageDelta : null,
      leader: leader ? { name: leader.name, average: leader.average, personId: leader.personId } : null,
      gapToLeader: me && leader && me.average !== null && leader.average !== null ? util.round(leader.average - me.average, 2) : null,
      gapToNext: me && next && me.average !== null && next.average !== null ? util.round(next.average - me.average, 2) : null,
      aheadOfMe: me ? list.filter(function (row) { return row.place < me.place; }).length : null,
      behindMe: me ? list.filter(function (row) { return row.place > me.place; }).length : null,
      aboveClassAverage: me && me.average !== null ? me.average >= stats.mean(averages) : null,
      bestPlace: places.length ? Math.min.apply(null, places) : null,
      worstPlace: places.length ? Math.max.apply(null, places) : null,
      histogram: stats.histogram(averages, 2, 5, 0.5)
    };
  }

  function normalizeMark(mark) {
    var raw = mark || {};
    return {
      id: util.asStr(util.firstDefined(raw.id, raw.mark_id, '')),
      value: util.asNum(util.firstDefined(raw.value, raw.mark, null)),
      subjectId: util.asStr(util.firstDefined(raw.subject_id, raw.subjectId, '')),
      subjectName: util.asStr(util.firstDefined(raw.subject_name, raw.subjectName, '—')),
      controlForm: util.asStr(util.firstDefined(raw.control_form_name, raw.controlForm, raw.form_name, '—')),
      weight: util.asNum(util.firstDefined(raw.weight, 1), 1),
      date: util.toIso(util.firstDefined(raw.created_at, raw.date, util.todayIso())),
      comment: util.asStr(util.firstDefined(raw.comment, '')),
      isExam: util.asBool(util.firstDefined(raw.is_exam, raw.isExam, false)),
      raw: raw
    };
  }

  function marksPayload(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.payload || data.marks || data.items || [];
  }

  /** Сводка по оценкам: средняя, взвешенная по весу работы, распределение. */
  function summarizeMarks(marks) {
    var values = (marks || []).map(function (mark) { return mark.value; }).filter(function (v) { return v !== null; });
    var weightedSum = 0;
    var weights = 0;
    (marks || []).forEach(function (mark) {
      if (mark.value === null) return;
      var w = mark.weight && mark.weight > 0 ? mark.weight : 1;
      weightedSum += mark.value * w;
      weights += w;
    });
    var bySubject = {};
    (marks || []).forEach(function (mark) {
      var key = mark.subjectId || mark.subjectName;
      if (!bySubject[key]) {
        bySubject[key] = { subjectId: mark.subjectId, subjectName: mark.subjectName, marks: [], values: [] };
      }
      bySubject[key].marks.push(mark);
      if (mark.value !== null) bySubject[key].values.push(mark.value);
    });
    var subjectList = Object.keys(bySubject).map(function (key) {
      var group = bySubject[key];
      return {
        subjectId: group.subjectId,
        subjectName: group.subjectName,
        count: group.marks.length,
        average: util.round(stats.mean(group.values), 2),
        median: util.round(stats.median(group.values), 2),
        color: stats.gradeColor(stats.mean(group.values)),
        marks: group.marks
      };
    }).sort(function (a, b) { return (b.average || 0) - (a.average || 0); });
    var byValue = [5, 4, 3, 2, 1].map(function (value) {
      var count = values.filter(function (v) { return Math.round(v) === value; }).length;
      return { value: value, count: count, color: stats.gradeColor(value) };
    });
    var sorted = (marks || []).slice().sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '');
    });
    return {
      count: (marks || []).length,
      withValue: values.length,
      average: util.round(stats.mean(values), 2),
      weightedAverage: weights ? util.round(weightedSum / weights, 2) : null,
      median: util.round(stats.median(values), 2),
      best: values.length ? Math.max.apply(null, values) : null,
      worst: values.length ? Math.min.apply(null, values) : null,
      bySubject: subjectList,
      byValue: byValue,
      lastMark: sorted[0] || null
    };
  }

  function normalizeHomework(item) {
    var raw = item || {};
    return {
      id: util.asStr(util.firstDefined(raw.homework_entry_student_id, raw.homework_id, raw.id, '')),
      subjectId: util.asStr(util.firstDefined(raw.subject_id, raw.subjectId, '')),
      subjectName: util.asStr(util.firstDefined(raw.subject_name, raw.subjectName, '—')),
      description: util.asStr(util.firstDefined(raw.description, raw.text, raw.homework, '')),
      assignedOn: util.toIso(util.firstDefined(raw.date_assigned_on, raw.date, util.todayIso())),
      dueDate: util.isBlank(util.firstDefined(raw.date_prepared, raw.deadline, raw.due_date, '')) ? null : util.toIso(util.firstDefined(raw.date_prepared, raw.deadline, raw.due_date)),
      isDone: util.asBool(util.firstDefined(raw.is_done, raw.isDone, false)),
      attachments: util.firstDefined(raw.attachments, raw.files, []) || [],
      raw: raw
    };
  }

  function payloadList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.payload || data.items || data.lessons || data.data || [];
  }

  /**
   * Расписание. Формат ответа отличается между регионами и подсистемами,
   * поэтому разбор «терпимый»: собираем все уроки из известных вариантов структуры.
   */
  function normalizeSchedule(data) {
    var lessons = [];
    var push = function (item, dayIso) {
      if (!item || typeof item !== 'object') return;
      var raw = item;
      var begin = util.firstDefined(raw.begin_time, raw.start_time, raw.startTime, raw.time_from, raw.time, null);
      var end = util.firstDefined(raw.end_time, raw.finish_time, raw.endTime, raw.time_to, null);
      lessons.push({
        date: util.toIso(util.firstDefined(raw.date, raw.day, dayIso, util.todayIso())),
        number: util.asInt(util.firstDefined(raw.lesson_number, raw.number, raw.lessonNumber, null)),
        begin: begin ? util.asStr(begin).slice(0, 5) : null,
        end: end ? util.asStr(end).slice(0, 5) : null,
        subject: util.asStr(util.firstDefined(raw.subject_name, raw.subjectName, util.deepGet(raw, 'subject.name', ''), '—')),
        teacher: util.asStr(util.firstDefined(raw.teacher_name, raw.teacherName, util.deepGet(raw, 'teacher.fio', ''), '')),
        room: util.asStr(util.firstDefined(raw.room_name, raw.room, raw.cabinet, util.deepGet(raw, 'room.name', ''), '')),
        homework: util.asStr(util.firstDefined(raw.homework, raw.home_task, raw.description, '')),
        mark: util.asNum(util.firstDefined(raw.mark, raw.mark_value, null)),
        isCancelled: util.asBool(util.firstDefined(raw.is_cancel, raw.isCancelled, false)),
        raw: raw
      });
    };
    var list = payloadList(data);
    list.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var dayIso = util.firstDefined(entry.date, entry.day, entry.date_from, null);
      var nested = entry.lessons || entry.lesson_list || entry.items || entry.schedule;
      if (Array.isArray(nested)) {
        nested.forEach(function (lesson) { push(lesson, dayIso); });
      } else if (nested && typeof nested === 'object') {
        Object.keys(nested).forEach(function (key) {
          var group = nested[key];
          if (Array.isArray(group)) group.forEach(function (lesson) { push(lesson, key); });
          else push(group, key);
        });
      } else {
        push(entry, dayIso);
      }
    });
    return lessons.sort(function (a, b) {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.begin && b.begin && a.begin !== b.begin) return a.begin.localeCompare(b.begin);
      return (a.number || 0) - (b.number || 0);
    });
  }

  // --------------------------------------------------------------- Клиент ----

  function defaultFetch() {
    if (typeof fetch === 'function') return fetch.bind(typeof globalThis !== 'undefined' ? globalThis : this);
    if (typeof require === 'function') return require('node-fetch');
    throw new MeshError('fetch недоступен в этой среде');
  }

  /**
   * Клиент МЭШ.
   * @param {object} options
   *   fetch        — функция fetch (можно подменить в тестах),
   *   token        — токен авторизации,
   *   profileId    — Profile-Id ученика,
   *   baseUrl      — по умолчанию https://school.mos.ru,
   *   timeout      — таймаут запроса в мс (по умолчанию 15000),
   *   autoRefresh  — обновлять токен при 401 и повторять запрос (по умолчанию true),
   *   onToken      — callback(newToken, meta) — вызывается после обновления токена.
   */
  function MeshClient(options) {
    var opts = options || {};
    this.baseUrl = (opts.baseUrl || HOST).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch || defaultFetch();
    this.timeout = opts.timeout || 15000;
    this.autoRefresh = opts.autoRefresh !== false;
    this.token = opts.token || null;
    this.profileId = opts.profileId ? String(opts.profileId) : null;
    this.onToken = typeof opts.onToken === 'function' ? opts.onToken : null;
    this.nameCache = opts.nameCache || Object.create(null);
    this._refreshPromise = null;
    this.requestCount = 0;
    this.lastError = null;
    /**
     * Демо-режим работает с локальным мок-сервером, где токены короткие
     * («mock-token-1»), поэтому строгая проверка формата там отключается.
     */
    this.allowLooseToken = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(this.baseUrl);
  }

  MeshClient.prototype.setToken = function (token) {
    this.token = token || null;
    return this;
  };

  MeshClient.prototype.setProfileId = function (profileId) {
    this.profileId = profileId ? String(profileId) : null;
    return this;
  };

  MeshClient.prototype.headers = function (extra) {
    var headers = baseHeaders();
    var auth = authHeaders(this.token, this.profileId);
    Object.keys(auth).forEach(function (key) { headers[key] = auth[key]; });
    Object.keys(extra || {}).forEach(function (key) { headers[key] = extra[key]; });
    return headers;
  };

  MeshClient.prototype.buildUrl = function (path, params) {
    var url = this.baseUrl + path;
    var query = [];
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '') return;
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    });
    return query.length ? url + '?' + query.join('&') : url;
  };

  /**
   * Базовый запрос с таймаутом, повтором после обновления токена и понятными ошибками.
   * @returns {Promise<any>}
   */
  MeshClient.prototype.request = async function (path, options) {
    var opts = options || {};
    var url = this.buildUrl(path, opts.params);
    var attempt = 0;
    var maxAttempts = this.autoRefresh && !opts.noRetry ? 2 : 1;
    var self = this;

    while (attempt < maxAttempts) {
      attempt++;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, this.timeout) : null;
      var response;
      try {
        this.requestCount++;
        response = await this.fetchImpl(url, {
          method: opts.method || 'GET',
          headers: this.headers(opts.headers),
          signal: controller ? controller.signal : undefined,
          body: opts.body ? JSON.stringify(opts.body) : undefined
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
          throw new MeshError('Таймаут запроса к МЭШ', { code: 'timeout', cause: error });
        }
        throw new MeshError('Сеть недоступна: ' + (error && error.message ? error.message : error), { code: 'network', cause: error });
      }
      if (timer) clearTimeout(timer);

      if (response.status === 401 && attempt < maxAttempts) {
        var refreshed = await this.refreshToken();
        if (refreshed) continue;
        throw new MeshError('Токен истёк, обновить не удалось', { code: 'unauthorized', status: 401 });
      }
      if (response.status === 401) throw new MeshError('Не авторизован (401)', { code: 'unauthorized', status: 401 });
      if (response.status === 403) throw new MeshError('Доступ запрещён (403)', { code: 'forbidden', status: 403 });
      if (response.status === 404) throw new MeshError('Метод не найден (404): ' + path, { code: 'not-found', status: 404 });
      if (!response.ok) {
        throw new MeshError('Ошибка МЭШ: HTTP ' + response.status + ' (' + path + ')', {
          code: 'http-' + response.status, status: response.status
        });
      }
      var text = await response.text();
      if (opts.raw) return text;
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (error) {
        var fromText = extractTokenFromText(text);
        if (fromText) return { token: fromText };
        throw new MeshError('Не удалось разобрать ответ МЭШ как JSON', { code: 'invalid-json', cause: error });
      }
    }
    throw new MeshError('Запрос не выполнен: ' + path, { code: 'exhausted' });
  };

  /** Обновление токена: GET /v2/token/refresh?roleId=1&subsystem=2 с текущим Bearer. */
  MeshClient.prototype.refreshToken = function () {
    var self = this;
    if (!this.token) return Promise.resolve(null);
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = (async function () {
      var url = self.buildUrl(PATHS.tokenRefresh, { roleId: ROLE_ID, subsystem: SUBSYSTEM_ID });
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, self.timeout) : null;
      try {
        var response = await self.fetchImpl(url, {
          method: 'GET',
          headers: self.headers({ 'Accept': 'application/json, text/plain, */*' }),
          signal: controller ? controller.signal : undefined
        });
        var text = await response.text();
        var token = extractTokenFromText(text) || extractTokenFromUrl(url);
        if (!token && self.allowLooseToken) token = extractLooseToken(text);
        if (response.ok && token && token !== self.token) {
          self.token = token;
          if (self.onToken) self.onToken(token, { reason: 'refresh' });
          return token;
        }
        return null;
      } catch (error) {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        self._refreshPromise = null;
      }
    })();
    return this._refreshPromise;
  };

  /** Проверка токена и получение профиля: используется при входе. */
  MeshClient.prototype.fetchProfile = function () {
    return this.request(PATHS.profile, { noRetry: true }).then(normalizeProfile);
  };

  /**
   * Вход по токену: сохраняет токен, тянет профиль, определяет ученика.
   * @returns {Promise<{token:string, profile:object, child:object|null, profileId:string|null}>}
   */
  MeshClient.prototype.signIn = async function (token) {
    var candidate = extractToken(token) || util.asStr(token).trim();
    if (!candidate) {
      throw new MeshError('Токен МЭШ пустой — вставьте значение целиком', { code: 'bad-token' });
    }
    if (!looksLikeToken(candidate) && !this.allowLooseToken) {
      throw new MeshError('Не похоже на токен МЭШ — скопируйте значение целиком', { code: 'bad-token' });
    }
    this.token = candidate;
    var profile = await this.fetchProfile();
    var child = profile.defaultChild;
    this.profileId = child ? child.id : null;
    return { token: candidate, profile: profile, child: child, profileId: this.profileId };
  };

  /** Список предметов с местами ученика. */
  MeshClient.prototype.getSubjects = function (personId, date) {
    return this.request(PATHS.subjects, { params: { date: date || util.todayIso(), personId: personId } })
      .then(function (data) { return payloadList(data).map(normalizeSubject); });
  };

  /** Рейтинг класса. subjectId не задан — общий рейтинг. */
  MeshClient.prototype.getRank = function (personId, date, subjectId) {
    return this.request(PATHS.rank, {
      params: { personId: personId, date: date || util.todayIso(), subjectId: subjectId || undefined }
    }).then(function (data) { return payloadList(data); });
  };

  /** Оценки за период. */
  MeshClient.prototype.getMarks = function (studentId, from, to) {
    return this.request(PATHS.marks, {
      params: { student_id: studentId, from: from, to: to }
    }).then(function (data) { return marksPayload(data).map(normalizeMark); });
  };

  /** Итоговые оценки по предметам. */
  MeshClient.prototype.getSubjectMarks = function (studentId) {
    return this.request(PATHS.subjectMarks, { params: { student_id: studentId } })
      .then(function (data) { return payloadList(data); });
  };

  /** Домашние задания за период. */
  MeshClient.prototype.getHomeworks = function (studentId, from, to) {
    return this.request(PATHS.homeworks, {
      params: { student_id: studentId, from: from, to: to }
    }).then(function (data) { return payloadList(data).map(normalizeHomework); });
  };

  /** Расписание (на дату или диапазон). */
  MeshClient.prototype.getSchedule = function (studentId, date, to) {
    return this.request(PATHS.schedule, {
      params: { student_id: studentId, date: date, to: to }
    }).then(function (data) { return normalizeSchedule(data); });
  };

  /** Имя ученика по personId (с кэшем). */
  MeshClient.prototype.getName = async function (personId) {
    var key = util.asStr(personId);
    if (!key) return 'Неизвестный ученик';
    if (this.nameCache[key]) return this.nameCache[key];
    try {
      var data = await this.request(PATHS.profileById, { params: { personId: key } });
      var name = personName(util.firstDefined(data.lastName, data.last_name, ''), util.firstDefined(data.firstName, data.first_name, ''), util.firstDefined(data.middleName, ''))
        || util.asStr(util.firstDefined(data.name, shortId(key)));
      this.nameCache[key] = name;
      return name;
    } catch (error) {
      this.nameCache[key] = shortId(key);
      return this.nameCache[key];
    }
  };

  /**
   * Имена для всех участников рейтинга (параллельно, с ограничением).
   * Кэш переиспользуется, поэтому повторные вызовы почти бесплатны.
   */
  MeshClient.prototype.getNames = async function (personIds, options) {
    var opts = options || {};
    var limit = opts.concurrency || 6;
    var ids = util.uniqBy((personIds || []).map(util.asStr).filter(Boolean), function (id) { return id; });
    var queue = ids.slice();
    var self = this;
    var names = {};
    async function worker() {
      while (queue.length) {
        var id = queue.shift();
        names[id] = await self.getName(id);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, queue.length || 1); i++) workers.push(worker());
    await Promise.all(workers);
    ids.forEach(function (id) { names[id] = names[id] || self.nameCache[id]; });
    return names;
  };

  /**
   * Рейтинг класса вместе с именами — то, что показывает вкладка «Рейтинг».
   */
  MeshClient.prototype.getRankBoard = async function (options) {
    var opts = options || {};
    var date = opts.date || util.todayIso();
    var members = await this.getRank(opts.personId, date, opts.subjectId);
    var ids = members.map(function (m) { return util.asStr(util.firstDefined(m.personId, m.person_id, '')); }).filter(Boolean);
    var names = opts.names || {};
    var missing = ids.filter(function (id) { return !names[id]; });
    if (missing.length && opts.withNames !== false) {
      names = Object.assign({}, names, await this.getNames(missing, { concurrency: opts.concurrency || 6 }));
    }
    var rows = buildRankTable(members, { names: names, meId: opts.personId });
    return {
      rows: rows,
      summary: summarizeRank(rows, opts.personId),
      date: date,
      subjectId: opts.subjectId || null,
      subjectName: opts.subjectName || null
    };
  };

  /** Проверка соединения: ping профиля, возвращает true/false без исключений. */
  MeshClient.prototype.ping = async function () {
    try {
      await this.fetchProfile();
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  };

  return {
    HOST: HOST,
    PATHS: PATHS,
    ROLE_ID: ROLE_ID,
    SUBSYSTEM: SUBSYSTEM,
    SUBSYSTEM_ID: SUBSYSTEM_ID,
    MeshError: MeshError,
    describeError: describeError,
    loginUrl: loginUrl,
    baseHeaders: baseHeaders,
    authHeaders: authHeaders,
    looksLikeToken: looksLikeToken,
    extractToken: extractToken,
    extractLooseToken: extractLooseToken,
    extractTokenFromText: extractTokenFromText,
    extractTokenFromUrl: extractTokenFromUrl,
    extractTokenFromObject: extractTokenFromObject,
    decodeJwt: decodeJwt,
    describeToken: describeToken,
    maskToken: maskToken,
    normalizeProfile: normalizeProfile,
    normalizeChild: normalizeChild,
    normalizeSubject: normalizeSubject,
    normalizeRankMember: normalizeRankMember,
    buildRankTable: buildRankTable,
    summarizeRank: summarizeRank,
    normalizeMark: normalizeMark,
    normalizeHomework: normalizeHomework,
    normalizeSchedule: normalizeSchedule,
    payloadList: payloadList,
    summarizeMarks: summarizeMarks,
    MeshClient: MeshClient
  };
});
