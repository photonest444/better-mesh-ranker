#!/usr/bin/env node
'use strict';
/*!
 * Дымовой тест приложения: поднимает демо-сервер и preview-сервер,
 * проходит путь пользователя (вход по токену → рейтинг → оценки → задания
 * → расписание → настройки) и падает с ненулевым кодом, если что-то сломано.
 *
 * Запуск: node tools/smoke-preview.js
 */

const path = require('path');
const { startMockMeshServer } = require(path.join(__dirname, 'mock-mesh-server.js'));
const { createPreviewServer } = require(path.join(__dirname, 'preview-server.js'));

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ✓ ${name}`);
    return true;
  }
  failures++;
  console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

async function call(base, route, options) {
  const response = await fetch(base + route, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { /* не JSON */ }
  return { status: response.status, json, text };
}

async function main() {
  console.log('Дымовой тест Mesh Ranker (демо-режим)\n');
  const mock = await startMockMeshServer({ seed: 11 });
  const server = createPreviewServer({ demo: true, mockPort: mock.port });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`Серверы: preview :${port}, мок-МЭШ :${mock.port}\n`);

  try {
    const health = await call(base, '/api/health');
    check('GET /api/health отвечает 200', health.status === 200 && health.json.ok === true);

    const index = await fetch(base + '/');
    const html = await index.text();
    check('статический интерфейс отдаётся', index.status === 200 && html.includes('Mesh Ranker'));

    const core = await fetch(base + '/core/mesh-core.js');
    check('ядро доступно по /core/', core.status === 200);

    const stateBefore = await call(base, '/api/state');
    check('GET /api/state сообщает про отсутствие сессии', stateBefore.json.data.authenticated === false);

    const demo = await call(base, '/api/demo/token', { method: 'POST' });
    check('POST /api/demo/token выдаёт демо-токен', demo.status === 200 && !!demo.json.data.token);

    const signIn = await call(base, '/api/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: demo.json.data.token })
    });
    const authenticated = signIn.json && signIn.json.data && signIn.json.data.authenticated;
    check('POST /api/sign-in выполняет вход', signIn.status === 200 && authenticated === true, signIn.text.slice(0, 200));
    if (!authenticated) throw new Error('вход не выполнен — дальше проверять нечего');

    const children = signIn.json.data.children || [];
    check('в профиле есть ученики', children.length >= 1);
    const studentId = signIn.json.data.activeStudentId;

    const subjects = await call(base, `/api/subjects?studentId=${studentId}`);
    const subjectList = subjects.json.data.subjects || [];
    check('GET /api/subjects возвращает предметы', subjects.status === 200 && subjectList.length === 14);

    const rank = await call(base, `/api/rank?studentId=${studentId}&date=2026-10-12`);
    const rows = rank.json.data.rows || [];
    const summary = rank.json.data.summary || {};
    check('GET /api/rank возвращает таблицу класса', rank.status === 200 && rows.length === 26, `строк: ${rows.length}`);
    check('в таблице есть имена', rows.every((row) => row.name && row.name.length > 3));
    check('в таблице ровно один «я»', rows.filter((row) => row.isMe).length === 1);
    check('места идут с 1', rows[0].place === 1 && rows[rows.length - 1].place === rows.length);
    check('сводка содержит средний балл класса', typeof summary.classAverage === 'number' && summary.classAverage > 2 && summary.classAverage <= 5);
    check('сводка содержит моё место', typeof summary.myPlace === 'number' && summary.myPlace >= 1);

    const subjectRank = await call(base, `/api/rank?studentId=${studentId}&date=2026-10-12&subjectId=1&subjectName=Алгебра`);
    check('GET /api/rank работает по предмету', subjectRank.status === 200 && (subjectRank.json.data.rows || []).length === 26);

    const marks = await call(base, `/api/marks?studentId=${studentId}&from=2026-09-01&to=2026-10-12`);
    const markList = marks.json.data.marks || [];
    check('GET /api/marks возвращает оценки', marks.status === 200 && markList.length > 10, `оценок: ${markList.length}`);
    check('оценки нормализованы (есть дата и предмет)', markList.every((mark) => mark.date && mark.subjectName));
    check('сводка по оценкам содержит средний балл', typeof marks.json.data.summary.average === 'number');

    const homeworks = await call(base, `/api/homeworks?studentId=${studentId}&from=2026-10-05&to=2026-10-12`);
    const homeworkList = homeworks.json.data.homeworks || [];
    check('GET /api/homeworks возвращает задания', homeworks.status === 200 && homeworkList.length > 3, `заданий: ${homeworkList.length}`);
    check('у заданий есть статус выполнения', homeworkList.every((item) => typeof item.isDone === 'boolean'));

    const schedule = await call(base, `/api/schedule?studentId=${studentId}&date=2026-10-12`);
    const lessons = schedule.json.data.lessons || [];
    check('GET /api/schedule возвращает уроки', schedule.status === 200 && lessons.length === 7, `уроков: ${lessons.length}`);
    check('уроки содержат время и предмет', lessons.every((lesson) => lesson.begin && lesson.subject));

    const names = await call(base, '/api/names?personIds=' + rows.slice(0, 3).map((row) => row.personId).join(','));
    check('GET /api/names возвращает имена', names.status === 200 && Object.keys(names.json.data.names).length === 3);

    const refreshed = await call(base, '/api/refresh-token', { method: 'POST' });
    check('POST /api/refresh-token продлевает сессию', refreshed.status === 200 && refreshed.json.data.authenticated === true, refreshed.text.slice(0, 200));

    const signOut = await call(base, '/api/sign-out', { method: 'POST' });
    check('POST /api/sign-out очищает сессию', signOut.status === 200 && signOut.json.data.authenticated === false);

    const guarded = await call(base, '/api/rank');
    check('без сессии методы недоступны', guarded.status === 401 || guarded.json.ok === false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    mock.server.close();
  }

  console.log(`\nПроверок: ${checks}, ошибок: ${failures}`);
  if (failures) {
    console.error('Дымовой тест провален');
    process.exit(1);
  }
  console.log('Все проверки пройдены');
}

main().catch((error) => {
  console.error('Дымовой тест упал с исключением:', error);
  process.exit(1);
});
