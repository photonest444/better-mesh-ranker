'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..', 'shared', 'core');
const MeshCore = require(path.join(CORE, 'mesh-core.js'));
const util = require(path.join(CORE, 'lib', 'util.js'));
const stats = require(path.join(CORE, 'lib', 'stats.js'));
const format = require(path.join(CORE, 'lib', 'format.js'));
const table = require(path.join(CORE, 'lib', 'table.js'));

const { startMockMeshServer, UUID_ME, UUID_SIBLING } = require(path.join(__dirname, '..', 'tools', 'mock-mesh-server.js'));

// ------------------------------------------------------------------ токен ----

test('токен распознаётся в JSON, тексте, URL и HTML', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo0MTAyNDQ0ODAwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.equal(MeshCore.extractTokenFromText(JSON.stringify({ token: jwt })), jwt);
  assert.equal(MeshCore.extractTokenFromText(`<html><body>"access_token": "${jwt}"</body></html>`), jwt);
  assert.equal(MeshCore.extractTokenFromText(jwt), jwt);
  assert.equal(MeshCore.extractTokenFromUrl(`https://school.mos.ru/v2/token/refresh?token=${jwt}&x=1`), jwt);
  assert.equal(MeshCore.extractTokenFromUrl(`https://school.mos.ru/#access_token=${jwt}`), jwt);
  assert.equal(MeshCore.extractToken({ data: { accessToken: jwt } }), jwt);
  assert.equal(MeshCore.extractToken('нет тут токена'), null);
});

test('looksLikeToken отсекает мусор', () => {
  assert.equal(MeshCore.looksLikeToken('abc'), false);
  assert.equal(MeshCore.looksLikeToken('a'.repeat(40)), false); // только буквы — не токен
  assert.equal(MeshCore.looksLikeToken('mock-token-1'), false); // короткий
  assert.equal(MeshCore.looksLikeToken('Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0'), true);
});

test('describeToken показывает маску и срок действия JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjo0MTAyNDQ0ODAwfQ.abc1234567';
  const info = MeshCore.describeToken(jwt);
  assert.equal(info.present, true);
  assert.equal(info.kind, 'jwt');
  assert.equal(info.expiresAt, 4102444800000);
  assert.equal(info.subjects, '1234567890');
  assert.match(info.mask, /…/);
  assert.equal(MeshCore.describeToken(null).present, false);
});

// ------------------------------------------------------------ нормализация ---

test('normalizeProfile собирает родителя и детей', () => {
  const profile = MeshCore.normalizeProfile({
    profile: { id: 1, last_name: 'Демидова', first_name: 'Ольга', middle_name: 'Сергеевна' },
    children: [
      { id: 42, contingent_guid: UUID_ME, last_name: 'Демидов', first_name: 'Пётр', class_name: '7 «Б»' },
      { id: 43, contingent_guid: UUID_SIBLING, last_name: 'Демидова', first_name: 'Аня' }
    ]
  });
  assert.equal(profile.parent.name, 'Демидова Ольга Сергеевна');
  assert.equal(profile.children.length, 2);
  assert.equal(profile.children[0].personId, UUID_ME);
  assert.equal(profile.children[0].id, '42');
  assert.equal(profile.children[0].name, 'Демидов Пётр');
  assert.equal(profile.defaultChild.id, '42');
});

test('normalizeRankMember считает дельту места и среднего', () => {
  const row = MeshCore.normalizeRankMember({
    personId: 'x',
    rank: { averageMarkFive: 4.75, rankPlace: 3, rankStatus: 'TOP', trend: '+0.25' },
    previousRank: { averageMarkFive: 4.5, rankPlace: 5 }
  }, 0);
  assert.equal(row.place, 3);
  assert.equal(row.average, 4.75);
  assert.equal(row.placeDelta, 2);      // поднялся на 2 позиции
  assert.equal(row.averageDelta, 0.25);
});

test('buildRankTable проставляет имена, флаг «это я» и сортирует по месту', () => {
  const rows = MeshCore.buildRankTable([
    { personId: 'b', rank: { averageMarkFive: 4.2, rankPlace: 2 } },
    { personId: 'a', rank: { averageMarkFive: 4.8, rankPlace: 1 } },
    { personId: 'c', rank: { averageMarkFive: 3.9, rankPlace: 3 } }
  ], { names: { a: 'Иванов Иван', b: 'Петров Пётр', c: 'Сидорова Анна' }, meId: 'b' });
  assert.deepEqual(rows.map((r) => r.place), [1, 2, 3]);
  assert.equal(rows[0].name, 'Иванов Иван');
  assert.equal(rows[1].isMe, true);
  assert.equal(rows[0].isMe, false);
  assert.equal(rows[0].color, 'green');
});

test('summarizeRank считает сводку по классу', () => {
  const rows = MeshCore.buildRankTable([
    { personId: 'a', rank: { averageMarkFive: 5, rankPlace: 1 } },
    { personId: 'b', rank: { averageMarkFive: 4, rankPlace: 2 } },
    { personId: 'c', rank: { averageMarkFive: 3, rankPlace: 3 } }
  ], { meId: 'b' });
  const summary = MeshCore.summarizeRank(rows, 'b');
  assert.equal(summary.total, 3);
  assert.equal(summary.classAverage, 4);
  assert.equal(summary.classMedian, 4);
  assert.equal(summary.myPlace, 2);
  assert.equal(summary.gapToLeader, 1);
  assert.equal(summary.aheadOfMe, 1);
  assert.equal(summary.behindMe, 1);
  assert.equal(summary.bestPlace, 1);
});

test('нормализация оценок, домашки и расписания', () => {
  const mark = MeshCore.normalizeMark({
    id: 7, value: 5, subject_id: 3, subject_name: 'Русский язык',
    control_form_name: 'Диктант', weight: 2, created_at: '2026-10-05 12:00:00', is_exam: false
  });
  assert.equal(mark.value, 5);
  assert.equal(mark.date, '2026-10-05');
  assert.equal(mark.weight, 2);
  assert.equal(mark.subjectName, 'Русский язык');

  const summary = MeshCore.summarizeMarks([
    { value: 5, weight: 1, subjectId: '1', subjectName: 'Алгебра', date: '2026-10-01' },
    { value: 4, weight: 3, subjectId: '1', subjectName: 'Алгебра', date: '2026-10-02' },
    { value: 3, weight: 1, subjectId: '2', subjectName: 'Физика', date: '2026-10-03' }
  ].map(MeshCore.normalizeMark));
  assert.equal(summary.count, 3);
  assert.equal(summary.average, 4);
  assert.equal(summary.weightedAverage, 4); // (5*1 + 4*3 + 3*1) / 5 = 4
  assert.equal(summary.bySubject.length, 2);
  assert.equal(summary.byValue.find((b) => b.value === 5).count, 1);
  assert.equal(summary.lastMark.date, '2026-10-03');

  const homework = MeshCore.normalizeHomework({
    homework_entry_student_id: 'h1', subject_name: 'История',
    description: 'Параграф 12', date_assigned_on: '2026-10-06', is_done: true
  });
  assert.equal(homework.isDone, true);
  assert.equal(homework.assignedOn, '2026-10-06');

  const lessons = MeshCore.normalizeSchedule({
    payload: [
      { date: '2026-10-06', lessons: [
        { lesson_number: 1, begin_time: '08:30:00', subject_name: 'Алгебра', room_name: '204', teacher_name: 'Соколова И. П.' },
        { lesson_number: 2, start_time: '09:25', subjectName: 'Геометрия', room: '211' }
      ] },
      { lesson_number: 3, begin_time: '10:30', subject_name: 'Физика' }
    ]
  });
  assert.equal(lessons.length, 3);
  assert.equal(lessons[0].begin, '08:30');
  assert.equal(lessons[1].subject, 'Геометрия');
  assert.equal(lessons[2].date, util.todayIso());
});

// ------------------------------------------------------------------ утилы ----

test('stats: средние, медиана, места и цвета', () => {
  assert.equal(stats.mean([5, 4, 3]), 4);
  assert.equal(stats.median([5, 3, 4, 4]), 4);
  assert.equal(stats.placeOf([5, 4, 4, 3], 4), 2);
  assert.equal(stats.gradeColor(4.6), 'green');
  assert.equal(stats.gradeColor(4.4), 'yellow');
  assert.equal(stats.gradeColor(3.4), 'orange');
  assert.equal(stats.gradeColor(2.4), 'red');
  assert.equal(stats.gradeColor(null), 'none');
  const hist = stats.histogram([5, 4.5, 4, 3.5], 3, 5, 0.5);
  assert.equal(hist.reduce((acc, b) => acc + b.count, 0), 4);
});

test('table: сортировка, фильтры, пагинация, итоги', () => {
  const rows = [
    { name: 'Аня', mark: 5 },
    { name: 'Борис', mark: null },
    { name: 'Вика', mark: 3.5 }
  ];
  assert.deepEqual(table.sortRows(rows, { key: 'mark', type: 'number', dir: 'desc' }).map((r) => r.name), ['Аня', 'Вика', 'Борис']);
  assert.deepEqual(table.sortRows(rows, { key: 'mark', type: 'number', dir: 'asc' }).map((r) => r.name), ['Вика', 'Аня', 'Борис']);
  assert.equal(table.filterRows(rows, 'вик').length, 1);
  const page = table.paginate(rows, 1, 2);
  assert.equal(page.rows.length, 2);
  assert.equal(page.pages, 2);
  assert.equal(page.total, 3);
  const summary = table.summarize(rows, [{ key: 'mark', type: 'number' }]);
  assert.equal(summary.mark.count, 2);
  assert.equal(summary.mark.mean, 4.25);
});

test('format: оценки, дельты, CSV и текстовые таблицы', () => {
  assert.equal(format.mark(4.6666), '4.67');
  assert.equal(format.mark(null), '—');
  assert.equal(format.markShort(4.5), '4,5');
  assert.equal(format.delta(4.75, 4.5), '+0.25');
  assert.equal(format.trendArrow(1), '▲');
  assert.equal(format.dateShort('2026-10-12'), '12.10.2026');
  assert.equal(format.dateRu('2026-10-12'), '12 октября 2026');
  assert.equal(format.pluralRu(5, 'ученик', 'ученика', 'учеников'), 'учеников');
  assert.equal(format.relativeTime(Date.now() - 5 * 60000), '5 минут назад');

  const csv = format.toCsv(
    [{ name: 'Иванов; Иван', mark: 4.75 }, { name: 'Петров, Пётр', mark: null }],
    [{ key: 'name', title: 'Ученик' }, { key: 'mark', title: 'Средний балл', value: (row) => format.markShort(row.mark) }],
    { title: 'Рейтинг класса' }
  );
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('Рейтинг класса'));
  assert.ok(csv.includes('"Иванов; Иван"'));
  assert.ok(csv.includes('"Петров, Пётр"'));
  assert.ok(csv.includes('\r\n'));
});

// ------------------------------------------------------------------ клиент ---

test('MeshClient: вход по токену и запросы к мок-МЭШ', async () => {
  const mock = await startMockMeshServer({ seed: 7 });
  const client = new MeshCore.MeshClient({
    baseUrl: `http://127.0.0.1:${mock.port}`,
    token: 'mock-token-1',
    timeout: 5000
  });
  const result = await client.signIn('mock-token-1');
  assert.equal(result.profile.children.length, 2);
  assert.equal(result.child.personId, UUID_ME);
  assert.equal(result.profileId, '17234613');

  const subjects = await client.getSubjects(UUID_ME, '2026-10-12');
  assert.equal(subjects.length, 14);
  assert.ok(subjects[0].name.length > 0);
  assert.ok(subjects[0].place >= 1);

  const board = await client.getRankBoard({ personId: UUID_ME, date: '2026-10-12' });
  assert.equal(board.rows.length, 26);
  assert.equal(board.rows.filter((r) => r.isMe).length, 1);
  assert.ok(board.rows[0].name.length > 3, 'имя первого ученика подтянулось');
  assert.ok(board.summary.classAverage > 2 && board.summary.classAverage <= 5);
  assert.ok(board.summary.myPlace >= 1);

  const subjectBoard = await client.getRankBoard({ personId: UUID_ME, date: '2026-10-12', subjectId: '1' });
  assert.equal(subjectBoard.rows.length, 26);

  const marks = await client.getMarks('17234613', '2026-09-01', '2026-10-12');
  assert.ok(marks.length > 10);
  assert.ok(MeshCore.summarizeMarks(marks).average > 2);

  const homeworks = await client.getHomeworks('17234613', '2026-10-05', '2026-10-12');
  assert.ok(homeworks.length > 3);
  assert.ok(homeworks[0].subjectName.length > 0);

  const lessons = await client.getSchedule('17234613', '2026-10-12');
  assert.equal(lessons.length, 7);

  mock.server.close();
});

test('MeshClient: при 401 автоматически обновляет токен и повторяет запрос', async () => {
  const mock = await startMockMeshServer({ seed: 3, tokenLifetime: 2 });
  const refreshed = [];
  const client = new MeshCore.MeshClient({
    baseUrl: `http://127.0.0.1:${mock.port}`,
    token: 'mock-token-1',
    timeout: 5000,
    onToken: (token, meta) => refreshed.push({ token, meta })
  });
  // три запроса подряд: на третьем мок вернёт 401 и клиент обязан обновиться
  await client.getSubjects(UUID_ME, '2026-10-12');
  await client.getSubjects(UUID_ME, '2026-10-12');
  const subjects = await client.getSubjects(UUID_ME, '2026-10-12');
  assert.equal(subjects.length, 14, 'запрос выполнен после автообновления токена');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].meta.reason, 'refresh');
  assert.match(refreshed[0].token, /^mock-token-/);
  assert.equal(client.token, refreshed[0].token);
  mock.server.close();
});

test('MeshClient: понятные ошибки вместо исключений транспорта', async () => {
  const client = new MeshCore.MeshClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 'x'.repeat(32),
    timeout: 300
  });
  await assert.rejects(
    () => client.getSubjects(UUID_ME, '2026-10-12'),
    (error) => {
      assert.equal(error.code, 'network');
      assert.match(MeshCore.describeError(error), /school.mos.ru/);
      return true;
    }
  );

  // Проверка формата токена работает для боевого МЭШ (в демо-режиме,
  // где база — локальный мок-сервер, короткие токены допустимы).
  const strict = new MeshCore.MeshClient({ baseUrl: MeshCore.HOST, token: null, timeout: 300 });
  await assert.rejects(() => strict.signIn('слишком-короткая-строка'), (error) => {
    assert.equal(error.code, 'bad-token');
    return true;
  });

  // А в демо-режиме короткий токен принимается и уходит в сеть
  const demo = new MeshCore.MeshClient({ baseUrl: 'http://127.0.0.1:1', token: null, timeout: 300 });
  assert.equal(demo.allowLooseToken, true);
});
