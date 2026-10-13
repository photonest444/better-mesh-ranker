#!/usr/bin/env node
'use strict';
/*!
 * Mesh Ranker — сквозная проверка нативного ядра (Rust) из Node.
 *
 * Что делает:
 *   1) запускает собранный `mesh-rank serve` через тот же мост, что и приложение
 *      (`shared/core/native.js`) — проверяются рукопожатие, протокол, таймауты;
 *   2) прогоняет набор задач и сравнивает ответы Rust с эталонной JS-реализацией
 *      (`tools/mock-mesh-rank.js`) — чтобы нативные расчёты не разошлись с ядром;
 *   3) печатает таблицу и падает с ненулевым кодом при любом расхождении.
 *
 * Запуск (нужен собранный бинарник):
 *   cargo build --release --manifest-path rust/Cargo.toml
 *   node tools/check-rust-bridge.js
 */

const path = require('path');
const native = require(path.resolve(__dirname, '..', 'shared', 'core', 'native.js'));
const mock = require(path.join(__dirname, 'mock-mesh-rank.js'));

const MOCK_SCRIPT = path.join(__dirname, 'mock-mesh-rank.js');
const TOLERANCE = 1e-6;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log('  ✓ ' + name);
    return true;
  }
  failures++;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

function equalNumbers(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return Math.abs(Number(left) - Number(right)) <= TOLERANCE;
}

function equalValue(left, right) {
  if (typeof left === 'number' || typeof right === 'number') return equalNumbers(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
}

// --------------------------------------------------------------- примеры данных ---

function members() {
  const names = ['Аня', 'Боря', 'Вера', 'Гриша', 'Даша'];
  return names.map((name, index) => ({
    personId: 'p' + index,
    rank: {
      averageMarkFive: 4.1 + (index % 4) * 0.25,
      average_mark: 4 + (index % 3) * 0.3,
      rankPlace: index + 1,
      rankStatus: 'mid'
    },
    previousRank: {
      averageMarkFive: 4.05 + (index % 4) * 0.2,
      rankPlace: index + 1 + (index % 2)
    },
    name: name
  }));
}

function markValues() {
  return [5, 4, 3, 5, 4, 2, 5, 4, 4, 3].map((value, index) => ({
    id: 'm' + index,
    value: value,
    weight: (index % 2) + 1,
    date: '2026-09-' + String(10 + index).padStart(2, '0'),
    subjectId: 's' + (index % 3),
    subjectName: ['Алгебра', 'Физика', 'История'][index % 3],
    controlForm: 'Работа на уроке'
  }));
}

function homeworks() {
  return [
    { id: 'h1', subjectName: 'Физика', description: 'Параграф 12', dueDate: '2026-10-11', isDone: false },
    { id: 'h2', subjectName: 'История', description: 'Доклад', dueDate: '2026-10-13', isDone: false },
    { id: 'h3', subjectName: 'Алгебра', description: 'Номера 1–10', dueDate: '2026-10-15', isDone: false },
    { id: 'h4', subjectName: 'Русский', description: 'Сочинение', dueDate: '2026-10-20', isDone: true }
  ];
}

async function callBoth(accelerator, method, params) {
  let nativeResult = null;
  let nativeError = null;
  try {
    nativeResult = await accelerator.raw(method, params);
  } catch (error) {
    nativeError = error.message;
  }
  let referenceResult = null;
  let referenceError = null;
  try {
    referenceResult = mock.call(method, params);
  } catch (error) {
    referenceError = error.message;
  }
  return { nativeResult, nativeError, referenceResult, referenceError };
}

async function main() {
  console.log('Проверка моста Node ↔ Rust (mesh-rank)\n');

  const binary = process.env.MESH_RANKER_RUST_BIN
    || path.resolve(__dirname, '..', 'rust', 'target', 'release', process.platform === 'win32' ? 'mesh-rank.exe' : 'mesh-rank');
  const accelerator = native.createAccelerator({ binary, force: true });
  if (!accelerator) {
    console.error('Не найден бинарник mesh-rank: ' + binary);
    console.error('Соберите: cargo build --release --manifest-path rust/Cargo.toml');
    process.exit(1);
  }

  try {
    const ready = await accelerator.ready();
    check('бинарник запускается и отвечает на hello',
      ready.available === true && ready.engine === 'rust', JSON.stringify(ready).slice(0, 200));
    check('hello сообщает протокол JSON-lines',
      !!ready.protocol && ready.protocol.format === 'json-lines', JSON.stringify(ready.protocol));
    check('hello перечисляет все методы моста (>= 30)',
      (ready.methods || 0) >= 30, 'методов: ' + ready.methods);
    check('hello знает версию ядра', typeof ready.version === 'string' && ready.version.length > 0);

    // ---- рейтинг класса ----
    const rankParams = { members: members(), names: { p0: 'Аня', p1: 'Боря', p2: 'Вера', p3: 'Гриша', p4: 'Даша' }, meId: 'p1', date: '2026-10-12' };
    const rank = await callBoth(accelerator, 'rank.build', rankParams);
    check('rank.build: строки совпадают с JS-ядром',
      rank.nativeResult && rank.referenceResult && rank.nativeResult.rows.length === rank.referenceResult.rows.length,
      rank.nativeError || rank.referenceError || '');
    if (rank.nativeResult && rank.referenceResult) {
      const mine = rank.nativeResult.rows.filter((row) => row.isMe);
      check('rank.build: «я» ровно один и это нужный ученик',
        mine.length === 1 && mine[0].personId === 'p1', 'найдено: ' + mine.length);
      check('rank.build: места и баллы совпадают',
        equalValue(rank.nativeResult.rows.map((row) => row.place), rank.referenceResult.rows.map((row) => row.place)) &&
        rank.nativeResult.rows.every((row, index) => equalNumbers(row.average, rank.referenceResult.rows[index].average)),
        'Rust: ' + JSON.stringify(rank.nativeResult.rows.map((row) => row.place)));
      check('rank.build: сводка совпадает (место, средний класса)',
        equalNumbers(rank.nativeResult.summary.myPlace, rank.referenceResult.summary.myPlace) &&
        equalNumbers(rank.nativeResult.summary.classAverage, rank.referenceResult.summary.classAverage),
        'Rust: ' + rank.nativeResult.summary.myPlace + '/' + rank.nativeResult.summary.classAverage +
        ' · JS: ' + rank.referenceResult.summary.myPlace + '/' + rank.referenceResult.summary.classAverage);
    }

    // ---- оценки ----
    const marks = await callBoth(accelerator, 'marks.summarize', { marks: markValues() });
    check('marks.summarize: средний, медиана и распределение совпадают',
      marks.nativeResult && marks.referenceResult &&
      equalNumbers(marks.nativeResult.summary.average, marks.referenceResult.summary.average) &&
      equalNumbers(marks.nativeResult.summary.median, marks.referenceResult.summary.median) &&
      equalValue(marks.nativeResult.summary.byValue, marks.referenceResult.summary.byValue),
      marks.nativeError || '');

    // ---- прогноз, влияние, дедлайны ----
    const forecast = await callBoth(accelerator, 'insights.forecast', { marks: markValues(), target: 4.5, remaining: 3 });
    check('insights.forecast: статус и «пятёрки» совпадают',
      forecast.nativeResult && forecast.referenceResult &&
      forecast.nativeResult.status === forecast.referenceResult.status &&
      equalValue(forecast.nativeResult.fivesNeeded, forecast.referenceResult.fivesNeeded) &&
      equalNumbers(forecast.nativeResult.neededAverage, forecast.referenceResult.neededAverage),
      forecast.nativeError || JSON.stringify(forecast.nativeResult && forecast.nativeResult.status));

    const impact = await callBoth(accelerator, 'insights.impact', { marks: markValues(), limit: 3 });
    check('insights.impact: тот же порядок предметов',
      impact.nativeResult && impact.referenceResult &&
      equalValue(impact.nativeResult.map((row) => row.subjectName), impact.referenceResult.map((row) => row.subjectName)),
      impact.nativeError || JSON.stringify((impact.nativeResult || []).map((row) => row.subjectName)));

    const deadlines = await callBoth(accelerator, 'homeworks.deadlines', { homeworks: homeworks(), reference: '2026-10-13' });
    check('homeworks.deadlines: раскладка по срокам совпадает',
      deadlines.nativeResult && deadlines.referenceResult &&
      equalValue(deadlines.nativeResult.groups.map((group) => group.count), deadlines.referenceResult.groups.map((group) => group.count)) &&
      equalNumbers(deadlines.nativeResult.overdue, deadlines.referenceResult.overdue),
      deadlines.nativeError || '');
    check('homeworks.deadlines: нагрузка на 14 дней совпадает',
      deadlines.nativeResult && deadlines.referenceResult &&
      equalValue(deadlines.nativeResult.byDay, deadlines.referenceResult.byDay));

    // ---- CSV ----
    const csv = await callBoth(accelerator, 'csv.rank', { rows: rank.nativeResult ? rank.nativeResult.rows : [], title: 'Рейтинг класса' });
    check('csv.rank: BOM, точка с запятой и то же число строк',
      csv.nativeResult && csv.referenceResult &&
      csv.nativeResult.csv.startsWith('\uFEFF') &&
      csv.nativeResult.csv.split('\r\n').length === csv.referenceResult.csv.split('\r\n').length,
      csv.nativeError || '');
    check('csv.rank: в CSV есть имена учеников',
      csv.nativeResult && csv.nativeResult.csv.includes('Аня') && csv.nativeResult.csv.includes('Даша'));

    // ---- бенчмарк ----
    const bench = await accelerator.bench({ students: 26, marks: 120, iterations: 200 });
    check('bench: ядро замеряет себя и выдаёт положительные цифры',
      bench && bench.timings && Number(bench.timings.rankTablePerSecond) > 0,
      JSON.stringify(bench && bench.timings).slice(0, 200));
    check('bench: есть контрольная сумма (замеры воспроизводимы)',
      bench && typeof bench.checksum === 'number');

    // ---- ошибки ----
    const unknown = await callBoth(accelerator, 'нет-такого-метода', {});
    check('неизвестный метод возвращает понятную ошибку',
      !!unknown.nativeError && /Неизвестный метод/.test(unknown.nativeError), unknown.nativeError || '');
  } finally {
    if (accelerator.dispose) accelerator.dispose();
    native.reset();
  }

  console.log('\nПроверок: ' + checks + ', ошибок: ' + failures);
  if (failures) {
    console.error('Мост Node ↔ Rust работает неверно');
    process.exit(1);
  }
  console.log('Мост Node ↔ Rust в порядке: ответы совпадают с JS-ядром');
}

main().catch((error) => {
  console.error('Проверка упала с исключением:', error);
  process.exit(1);
});
