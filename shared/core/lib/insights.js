/*!
 * Mesh Ranker — аналитика поверх данных МЭШ (UMD).
 *
 * Здесь три «умные» вещи, которых нет в исходном API МЭШ:
 *   1) прогноз: сколько нужно оценок, чтобы выйти на целевой средний балл;
 *   2) динамика: серия снимков рейтинга (место/балл) со спарклайном и дельтами;
 *   3) дедлайны: разбор домашних заданий по срокам и нагрузке по дням.
 *
 * Всё это реализовано и на Rust (`rust/crates/mesh-core/src/insights.rs`) с
 * теми же именами полей, поэтому интерфейс работает на любом движке,
 * а тесты сравнивают результаты JS и Rust на одних и тех же данных.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'), require('./stats.js'), require('./format.js'));
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    lib.insights = factory(lib.util, lib.stats, lib.format);
  }
})(typeof self !== 'undefined' ? self : this, function (util, stats, format) {
  'use strict';

  var SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

  function numbers(values) {
    var out = [];
    (values || []).forEach(function (value) {
      var num = util.asNum(value, null);
      if (num !== null && isFinite(num)) out.push(num);
    });
    return out;
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function round2(value) {
    return util.round(value, 2);
  }

  // ------------------------------------------------------------- спарклайн ---

  /**
   * Текстовая мини-диаграмма: `sparkline([4.1, 4.3, 4.5])` → «▁▄█».
   * `options.invert = true` используется для мест (меньше — лучше).
   */
  function sparkline(values, options) {
    var opts = options || {};
    var list = numbers(values);
    if (!list.length) return '';
    var min = stats.min(list);
    var max = stats.max(list);
    var span = max - min;
    var out = '';
    list.forEach(function (value) {
      var ratio = span <= 0 ? 0.5 : (value - min) / span;
      if (opts.invert) ratio = 1 - ratio;
      var index = Math.min(7, Math.floor(ratio * 7));
      out += SPARK_CHARS[index];
    });
    return out;
  }

  // -------------------------------------------------------------- прогноз ---

  /**
   * Прогноз до целевого среднего балла.
   *
   * @param {Array} marks оценки (нормализованные: {value, weight, ...})
   * @param {number} target целевой средний балл (например 4.5)
   * @param {number} remaining сколько работ ещё ожидается (по умолчанию 1)
   */
  function forecast(marks, target, remaining) {
    var goal = util.asNum(target, 4.5);
    var left = Math.max(1, util.asInt(remaining, 1) || 1);
    var list = marks || [];
    var values = [];
    var weightedSum = 0;
    var weights = 0;
    list.forEach(function (mark) {
      var value = util.asNum(mark ? mark.value : null, null);
      if (value === null || !isFinite(value)) return;
      values.push(value);
      var weight = util.asNum(mark ? mark.weight : null, 1);
      if (!weight || weight <= 0) weight = 1;
      weightedSum += value * weight;
      weights += weight;
    });

    var count = values.length;
    var total = stats.sum(values);
    var average = count ? total / count : null;
    var weighted = weights > 0 ? weightedSum / weights : null;
    var current = average === null ? 0 : average;
    var gap = goal - current;
    var needed = count === 0 ? goal : (goal * (count + left) - total) / left;
    var fivesNeeded;
    if (count === 0) {
      fivesNeeded = left;
    } else if (goal >= 5) {
      fivesNeeded = Infinity;
    } else {
      var numerator = goal * count - total;
      fivesNeeded = numerator <= 0 ? 0 : Math.ceil(numerator / (5 - goal));
    }
    var maxPossible = count === 0 ? 5 : (total + 5 * left) / (count + left);
    var minPossible = count === 0 ? 2 : (total + 2 * left) / (count + left);
    var status;
    if (average !== null && average >= goal - 1e-9) status = 'done';
    else if (needed <= 5 + 1e-9) status = 'achievable';
    else status = 'unreachable';

    var message;
    if (status === 'done') {
      message = 'Цель ' + format.markShort(goal) + ' уже достигнута: средний балл ' + format.markShort(average);
    } else if (status === 'achievable') {
      message = 'Нужно ещё ' + format.marksCount(Math.min(fivesNeeded === Infinity ? left : fivesNeeded, left))
        + ' (или среднее ' + format.markShort(needed) + ' за ' + left + ' ' + pluralWorks(left) + ')';
    } else {
      message = 'Даже одни «пятёрки» дадут максимум ' + format.markShort(maxPossible)
        + ' — цель ' + format.markShort(goal) + ' пока не достижима';
    }

    return {
      count: count,
      withValue: count,
      sum: total,
      average: average === null ? null : round2(average),
      weightedAverage: weighted === null ? null : round2(weighted),
      target: goal,
      gap: round2(gap),
      remaining: left,
      neededAverage: needed === null || !isFinite(needed) ? null : round2(needed),
      fivesNeeded: isFinite(fivesNeeded) ? fivesNeeded : null,
      maxPossible: round2(maxPossible),
      minPossible: round2(minPossible),
      status: status,
      text: message
    };
  }

  function pluralWorks(count) {
    return util.asStr(count) + ' ' + format.pluralRu(count, 'работа', 'работы', 'работ');
  }

  /** «А что если?» — как изменится средний балл от новых оценок. */
  function whatIf(marks, extraValues) {
    var values = [];
    ((marks || []).map(function (mark) { return mark ? mark.value : null; })).forEach(function (value) {
      var num = util.asNum(value, null);
      if (num !== null && isFinite(num)) values.push(num);
    });
    var extra = numbers(extraValues);
    var before = values.length ? stats.mean(values) : null;
    var after = values.concat(extra);
    var afterAverage = after.length ? stats.mean(after) : null;
    return {
      before: before === null ? null : round2(before),
      after: afterAverage === null ? null : round2(afterAverage),
      delta: before === null || afterAverage === null ? null : round2(afterAverage - before),
      count: values.length,
      added: extra
    };
  }

  /**
   * Влияние оценок по предметам: где одна «пятёрка» даст наибольший прирост.
   * Ответ отсортирован по убыванию прироста.
   */
  function subjectImpact(marks, limit) {
    var groups = {};
    var order = [];
    (marks || []).forEach(function (mark) {
      var value = util.asNum(mark ? mark.value : null, null);
      if (value === null || !isFinite(value)) return;
      var key = util.asStr(mark.subjectId) || util.asStr(mark.subjectName) || '—';
      if (!groups[key]) {
        groups[key] = { subjectId: util.asStr(mark.subjectId), subjectName: util.asStr(mark.subjectName) || '—', sum: 0, count: 0 };
        order.push(key);
      }
      groups[key].sum += value;
      groups[key].count += 1;
    });
    var total = order.reduce(function (acc, key) { return acc + groups[key].count; }, 0);
    var rows = order.map(function (key) {
      var group = groups[key];
      var average = group.sum / group.count;
      var nextFive = (group.sum + 5) / (group.count + 1);
      return {
        subjectId: group.subjectId,
        subjectName: group.subjectName,
        count: group.count,
        average: round2(average),
        deltaIfFive: round2(nextFive - average),
        share: util.round(total ? group.count / total : 0, 3)
      };
    });
    rows.sort(function (a, b) { return (b.deltaIfFive || 0) - (a.deltaIfFive || 0); });
    var max = util.asInt(limit, 0);
    return max > 0 ? rows.slice(0, max) : rows;
  }

  // -------------------------------------------------------------- динамика ---

  /** Снимок рейтинга из ответа платформы (метод `rank`). */
  function snapshotFromBoard(board, options) {
    var opts = options || {};
    var summary = (board && board.summary) || {};
    return {
      date: util.toIso((board && board.date) || util.todayIso()),
      subjectId: (board && board.subjectId) || null,
      subjectName: (board && board.subjectName) || null,
      myPlace: summary.myPlace === undefined ? null : summary.myPlace,
      myAverage: summary.myAverage === undefined ? null : summary.myAverage,
      classAverage: summary.classAverage === undefined ? null : summary.classAverage,
      total: summary.total || (board && board.rows ? board.rows.length : 0) || 0,
      savedAt: opts.savedAt || Date.now()
    };
  }

  function matchesSubject(snapshot, subjectId) {
    var current = snapshot.subjectId === undefined ? null : snapshot.subjectId;
    if (subjectId === null || subjectId === undefined) return current === null || current === '';
    return util.asStr(current) === util.asStr(subjectId);
  }

  /**
   * Серия «динамика» по сохранённым снимкам: точки, дельты, лучший/худший
   * результат, спарклайны места и балла.
   */
  function historySeries(snapshots, subjectId) {
    var selected = (snapshots || []).filter(function (snapshot) { return matchesSubject(snapshot || {}, subjectId); });
    selected.sort(function (a, b) { return util.asStr(a.date).localeCompare(util.asStr(b.date)); });

    // По одной точке на дату: последний снимок «побеждает».
    var unique = [];
    selected.forEach(function (snapshot) {
      var last = unique[unique.length - 1];
      if (last && last.date === snapshot.date) unique[unique.length - 1] = snapshot;
      else unique.push(snapshot);
    });

    var points = unique.map(function (snapshot) {
      return {
        date: snapshot.date,
        place: snapshot.myPlace === undefined ? null : snapshot.myPlace,
        average: snapshot.myAverage === undefined ? null : snapshot.myAverage,
        classAverage: snapshot.classAverage === undefined ? null : snapshot.classAverage,
        total: snapshot.total || 0
      };
    });
    var places = numbers(points.map(function (point) { return point.place; }));
    var averages = numbers(points.map(function (point) { return point.average; }));

    var first = unique[0] || null;
    var last = unique[unique.length - 1] || null;
    var firstPlace = first ? (first.myPlace === undefined ? null : first.myPlace) : null;
    var lastPlace = last ? (last.myPlace === undefined ? null : last.myPlace) : null;
    var firstAverage = first ? (first.myAverage === undefined ? null : first.myAverage) : null;
    var lastAverage = last ? (last.myAverage === undefined ? null : last.myAverage) : null;
    var placeDelta = firstPlace === null || lastPlace === null ? null : firstPlace - lastPlace;
    var averageDelta = firstAverage === null || lastAverage === null ? null : round2(lastAverage - firstAverage);

    var bestPlace = stats.min(places);
    var worstPlace = stats.max(places);
    var bestPlaceDate = '';
    var worstPlaceDate = '';
    unique.forEach(function (snapshot) {
      if (!bestPlaceDate && bestPlace !== null && snapshot.myPlace === bestPlace) bestPlaceDate = snapshot.date;
      if (worstPlace !== null && snapshot.myPlace === worstPlace) worstPlaceDate = snapshot.date;
    });

    var trend = 0;
    if (placeDelta !== null && placeDelta > 0) trend = 1;
    else if (placeDelta !== null && placeDelta < 0) trend = -1;
    else if (averageDelta !== null && averageDelta > 0.005) trend = 1;
    else if (averageDelta !== null && averageDelta < -0.005) trend = -1;

    return {
      subjectId: subjectId === undefined ? null : subjectId,
      count: unique.length,
      points: points,
      firstDate: first ? first.date : '',
      lastDate: last ? last.date : '',
      firstAverage: firstAverage,
      lastAverage: lastAverage,
      averageDelta: averageDelta,
      firstPlace: firstPlace,
      lastPlace: lastPlace,
      placeDelta: placeDelta,
      bestPlace: bestPlace,
      bestPlaceDate: bestPlaceDate,
      worstPlace: worstPlace,
      worstPlaceDate: worstPlaceDate,
      trend: trend,
      improved: (placeDelta !== null && placeDelta > 0)
        || (placeDelta === 0 && averageDelta !== null && averageDelta > 0),
      sparkline: sparkline(averages),
      placeSparkline: sparkline(places, { invert: true })
    };
  }

  // -------------------------------------------------------------- дедлайны ---

  var DEADLINE_GROUPS = [
    { key: 'overdue', label: 'Просрочено' },
    { key: 'today', label: 'Сегодня' },
    { key: 'tomorrow', label: 'Завтра' },
    { key: 'week', label: 'На неделе' },
    { key: 'later', label: 'Позже' },
    { key: 'no-deadline', label: 'Без срока' },
    { key: 'done', label: 'Выполнено' }
  ];

  /**
   * Разбор домашних заданий по срокам: группы, прогресс, нагрузка по дням
   * и ближайшее несданное задание.
   */
  function deadlines(homeworks, referenceIso) {
    var today = util.toIso(referenceIso || util.todayIso());
    var tomorrow = util.addDays(today, 1);
    var weekEnd = util.addDays(today, 7);
    var groups = {};
    DEADLINE_GROUPS.forEach(function (group) { groups[group.key] = []; });

    var done = 0;
    var undone = 0;
    var overdue = 0;
    var next = null;          // самое срочное несданное (включая просроченное)
    var nextUpcoming = null;  // ближайшее из тех, что ещё не просрочены

    (homeworks || []).forEach(function (item) {
      var homework = item || {};
      if (homework.isDone) {
        done += 1;
        groups.done.push(homework);
        return;
      }
      undone += 1;
      var due = homework.dueDate ? util.toIso(homework.dueDate) : null;
      var key;
      if (!due) key = 'no-deadline';
      else if (due < today) key = 'overdue';
      else if (due === today) key = 'today';
      else if (due === tomorrow) key = 'tomorrow';
      else if (due <= weekEnd) key = 'week';
      else key = 'later';
      if (key === 'overdue') overdue += 1;
      if (key !== 'later' && key !== 'no-deadline') {
        var currentDue = next && next.dueDate ? util.toIso(next.dueDate) : null;
        if (!next || !currentDue || (due && due < currentDue)) next = homework;
      }
      if (key === 'today' || key === 'tomorrow' || key === 'week') {
        var upcomingDue = nextUpcoming && nextUpcoming.dueDate ? util.toIso(nextUpcoming.dueDate) : null;
        if (!nextUpcoming || !upcomingDue || (due && due < upcomingDue)) nextUpcoming = homework;
      }
      groups[key].push(homework);
    });

    var total = (homeworks || []).length;
    var byDay = [];
    for (var offset = 0; offset < 14; offset += 1) {
      var date = util.addDays(today, offset);
      byDay.push({
        date: date,
        count: (homeworks || []).filter(function (item) {
          return item && item.dueDate && util.toIso(item.dueDate) === date;
        }).length
      });
    }

    var deadlineGroups = DEADLINE_GROUPS.map(function (group) {
      return { key: group.key, label: group.label, count: groups[group.key].length, items: groups[group.key] };
    });

    return {
      reference: today,
      total: total,
      done: done,
      undone: undone,
      overdue: overdue,
      progress: util.round(total ? done / total : 0, 3),
      groups: deadlineGroups,
      byDay: byDay,
      next: next,
      nextUpcoming: nextUpcoming
    };
  }

  /** Короткая сводка по заданиям — для бейджей в интерфейсе. */
  function progressOf(homeworks, referenceIso) {
    var report = deadlines(homeworks, referenceIso);
    return {
      total: report.total,
      done: report.done,
      undone: report.undone,
      overdue: report.overdue,
      progress: report.progress,
      percent: util.round(report.progress * 100, 1),
      dueSoon: report.groups[1].count + report.groups[2].count + report.groups[3].count,
      next: report.next,
      nextUpcoming: report.nextUpcoming
    };
  }

  // ------------------------------------------------------- сравнение предметов --

  /**
   * Сравнение предметов по готовым таблицам рейтинга:
   * моё место, мой балл, средний по классу, отрыв и тренд.
   */
  function compareBoards(boards) {
    return (boards || []).map(function (board) {
      var summary = (board && board.summary) || {};
      var myPlace = summary.myPlace === undefined ? null : summary.myPlace;
      var total = summary.total || 0;
      var gapToClass = summary.myAverage !== null && summary.myAverage !== undefined && summary.classAverage !== null && summary.classAverage !== undefined
        ? round2(summary.myAverage - summary.classAverage)
        : null;
      return {
        subjectId: (board && board.subjectId) || null,
        subjectName: (board && board.subjectName) || 'Общий рейтинг',
        myPlace: myPlace,
        total: total,
        myAverage: summary.myAverage === undefined ? null : summary.myAverage,
        classAverage: summary.classAverage === undefined ? null : summary.classAverage,
        gapToClass: gapToClass,
        bestPlace: summary.bestPlace === undefined ? null : summary.bestPlace,
        trend: summary.myTrend === undefined ? 0 : summary.myTrend,
        color: stats.gradeColor(summary.myAverage)
      };
    }).sort(function (a, b) { return (a.myPlace || 999) - (b.myPlace || 999); });
  }

  // ------------------------------------------------------- локальная история --

  var HISTORY_KEY = 'mesh.history.v1';
  var HISTORY_LIMIT = 500;

  function memoryStorage() {
    var data = {};
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
      setItem: function (key, value) { data[key] = String(value); },
      removeItem: function (key) { delete data[key]; }
    };
  }

  /**
   * Хранилище снимков рейтинга (по ученикам).
   * По умолчанию — `localStorage`; его нет (Node/тесты) — работаем в памяти.
   */
  function createHistoryStore(options) {
    var opts = options || {};
    var storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
    var key = opts.key || HISTORY_KEY;
    var limit = opts.limit || HISTORY_LIMIT;

    function readAll() {
      try {
        var parsed = JSON.parse(storage.getItem(key) || 'null');
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed;
      } catch (error) {
        return {};
      }
    }

    function writeAll(data) {
      try {
        storage.setItem(key, JSON.stringify(data));
        return true;
      } catch (error) {
        // Переполнили квоту — оставляем только свежие снимки.
        try {
          var trimmed = {};
          Object.keys(data).forEach(function (studentId) {
            trimmed[studentId] = data[studentId].slice(-Math.floor(limit / 2));
          });
          storage.setItem(key, JSON.stringify(trimmed));
          return true;
        } catch (secondError) {
          return false;
        }
      }
    }

    return {
      key: key,
      /** Все снимки ученика (по возрастанию даты). */
      all: function (studentId) {
        var data = readAll();
        var list = data[util.asStr(studentId)] || [];
        return list.slice().sort(function (a, b) { return util.asStr(a.date).localeCompare(util.asStr(b.date)); });
      },
      /** Добавляет снимок; повторный той же даты/предмета перезаписывается. */
      append: function (studentId, snapshot) {
        var id = util.asStr(studentId) || 'me';
        var data = readAll();
        var list = data[id] || [];
        var entry = Object.assign({}, snapshot, { savedAt: snapshot.savedAt || Date.now() });
        var replaced = false;
        for (var index = 0; index < list.length; index += 1) {
          var sameDate = util.asStr(list[index].date) === util.asStr(entry.date);
          var sameSubject = util.asStr(list[index].subjectId) === util.asStr(entry.subjectId);
          if (sameDate && sameSubject) {
            list[index] = entry;
            replaced = true;
            break;
          }
        }
        if (!replaced) list.push(entry);
        list.sort(function (a, b) { return util.asStr(a.date).localeCompare(util.asStr(b.date)); });
        if (list.length > limit) list = list.slice(-limit);
        data[id] = list;
        writeAll(data);
        return entry;
      },
      clear: function (studentId) {
        var data = readAll();
        delete data[util.asStr(studentId)];
        writeAll(data);
      },
      clearAll: function () {
        try { storage.removeItem(key); } catch (error) { /* ничего страшного */ }
      },
      counts: function () {
        var data = readAll();
        var out = {};
        Object.keys(data).forEach(function (studentId) { out[studentId] = (data[studentId] || []).length; });
        return out;
      },
      exportJson: function () {
        return JSON.stringify({ version: 1, savedAt: Date.now(), students: readAll() }, null, 2);
      },
      importJson: function (text) {
        try {
          var parsed = JSON.parse(text);
          var incoming = parsed && parsed.students ? parsed.students : parsed;
          if (!incoming || typeof incoming !== 'object') return false;
          var data = readAll();
          Object.keys(incoming).forEach(function (studentId) {
            var list = data[studentId] || [];
            (incoming[studentId] || []).forEach(function (snapshot) {
              if (!snapshot || !snapshot.date) return;
              var replaced = false;
              for (var index = 0; index < list.length; index += 1) {
                if (util.asStr(list[index].date) === util.asStr(snapshot.date)
                  && util.asStr(list[index].subjectId) === util.asStr(snapshot.subjectId)) {
                  list[index] = snapshot;
                  replaced = true;
                  break;
                }
              }
              if (!replaced) list.push(snapshot);
            });
            list.sort(function (a, b) { return util.asStr(a.date).localeCompare(util.asStr(b.date)); });
            data[studentId] = list.slice(-limit);
          });
          writeAll(data);
          return true;
        } catch (error) {
          return false;
        }
      }
    };
  }

  // ------------------------------------------------------------- глобальный поиск --

  /**
   * Оценка совпадения для палитры команд (Ctrl+K).
   * Возвращает {score, index} или null: чем больше score, тем релевантнее.
   */
  function scoreMatch(haystack, needle) {
    var text = util.asStr(haystack).toLowerCase();
    var query = util.asStr(needle).toLowerCase().trim();
    if (!query) return null;
    var index = text.indexOf(query);
    if (index < 0) {
      // Поиск по словам: все слова запроса должны встретиться.
      var words = query.split(/\s+/).filter(Boolean);
      var cursor = 0;
      var positions = [];
      for (var i = 0; i < words.length; i += 1) {
        var found = text.indexOf(words[i], cursor);
        if (found < 0) return null;
        positions.push(found);
        cursor = found + words[i].length;
      }
      return { score: 40 - Math.min(30, positions[positions.length - 1]), index: positions[0] };
    }
    var score = 100 - index;
    if (index === 0) score += 30;
    else if (/\s/.test(text.charAt(index - 1))) score += 15;
    return { score: score, index: index };
  }

  /**
   * Поиск по элементам разных типов (предметы, оценки, задания, уроки).
   * `items` — [{id, title, subtitle, group, action, keywords}]
   */
  function searchItems(items, query, options) {
    var opts = options || {};
    var limit = util.asInt(opts.limit, 12) || 12;
    var query2 = util.asStr(query).trim();
    var results = [];
    (items || []).forEach(function (item) {
      if (!item || opts.group && item.group !== opts.group) return;
      var haystacks = [item.title, item.subtitle, item.keywords];
      var best = null;
      haystacks.forEach(function (haystack) {
        var match = scoreMatch(haystack, query2);
        if (match && (!best || match.score > best.score)) best = match;
      });
      if (!best) return;
      var rank = 0;
      if (item.group === 'view') rank += 20;
      else if (item.group === 'subject') rank += 10;
      results.push(Object.assign({}, item, { score: best.score + rank }));
    });
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return util.asStr(a.title).localeCompare(util.asStr(b.title));
    });
    return results.slice(0, limit);
  }

  return {
    SPARK_CHARS: SPARK_CHARS,
    sparkline: sparkline,
    forecast: forecast,
    whatIf: whatIf,
    subjectImpact: subjectImpact,
    snapshotFromBoard: snapshotFromBoard,
    historySeries: historySeries,
    deadlines: deadlines,
    progressOf: progressOf,
    compareBoards: compareBoards,
    createHistoryStore: createHistoryStore,
    searchItems: searchItems,
    scoreMatch: scoreMatch
  };
});
