#!/usr/bin/env node
'use strict';
/*!
 * Mesh Ranker — эталонная JS-реализация протокола нативного ядра.
 *
 * Зачем это нужно:
 *   1) проверять мост `shared/core/native.js` до сборки Rust — тесты запускают
 *      этот «мок-бинарник» вместо настоящего mesh-rank (флаг args в createAccelerator);
 *   2) сверять ответы Rust и JS на одних данных (tools/check-rust-bridge.js):
 *      если реализация на Rust разойдётся с ядром, CI это заметит.
 *
 * Протокол тот же: одна строка — один запрос `{id, method, params}`,
 * ответ — `{id, ok, result|error}`. Первый аргумент `serve` игнорируется.
 */

const path = require('path');

const CORE = path.resolve(__dirname, '..', 'shared', 'core');
const MeshCore = require(path.join(CORE, 'mesh-core.js'));
const util = require(path.join(CORE, 'lib', 'util.js'));
const format = require(path.join(CORE, 'lib', 'format.js'));
const insights = require(path.join(CORE, 'lib', 'insights.js'));
const statsLib = require(path.join(CORE, 'lib', 'stats.js'));
const benchCompare = require(path.join(CORE, 'bench-compare.js'));

const METHODS = [
  'hello', 'state', 'token.describe', 'token.extract', 'stats.describe', 'rank.build',
  'marks.summarize', 'schedule.normalize', 'homeworks.deadlines', 'insights.history',
  'insights.forecast', 'insights.whatIf', 'insights.impact', 'csv.rank', 'csv.marks',
  'bench', 'cache.stats'
];

const history = [];

function obj(entries) {
  const out = {};
  entries.forEach(([key, value]) => { out[key] = value; });
  return out;
}

function rankRowJson(row) {
  const copy = Object.assign({}, row);
  delete copy.raw;
  return copy;
}

function toIso(value) {
  return util.toIso(value || util.todayIso());
}

function call(method, params) {
  const p = params || {};
  switch (method) {
    case 'hello':
      return obj([
        ['name', 'mesh-rank'],
        ['engine', 'js-mock'],
        ['version', '1.1.0-mock'],
        ['methods', METHODS],
        ['demo', false],
        ['transport', 'mock'],
        ['protocol', { format: 'json-lines', version: 1 }]
      ]);

    case 'state':
      return obj([['authenticated', false], ['engine', 'js-mock'], ['methods', METHODS.length]]);

    case 'token.describe':
      return MeshCore.describeToken(p.token || null);

    case 'token.extract':
      return obj([['token', MeshCore.extractToken(p.text || '') || null]]);

    case 'stats.describe':
      return statsLib.describe(p.values || []);

    case 'rank.build': {
      const members = p.members || [];
      const names = p.names || {};
      const meId = util.asStr(p.meId || '');
      const rows = MeshCore.buildRankTable(members, { names, meId, date: p.date });
      const summary = MeshCore.summarizeRank(rows, meId);
      const clean = rows.map(rankRowJson);
      return obj([
        ['date', toIso(p.date)],
        ['subjectId', p.subjectId || null],
        ['subjectName', p.subjectName || null],
        ['rows', clean],
        ['summary', Object.assign({}, summary, { myRow: summary.myRow ? rankRowJson(summary.myRow) : null })]
      ]);
    }

    case 'marks.summarize': {
      const marks = (p.marks || p.payload || p.items || []).map((mark) => MeshCore.normalizeMark(mark));
      return obj([['marks', marks], ['summary', MeshCore.summarizeMarks(marks)]]);
    }

    case 'schedule.normalize':
      return obj([['lessons', MeshCore.normalizeSchedule(p.payload || p)]]);

    case 'homeworks.deadlines': {
      const items = p.homeworks && p.homeworks.length
        ? p.homeworks.map((item) => MeshCore.normalizeHomework(item))
        : MeshCore.payloadList(p.payload || {}).map((item) => MeshCore.normalizeHomework(item));
      return insights.deadlines(items, p.reference);
    }

    case 'insights.forecast': {
      const marks = (p.marks || p.payload || []).map((mark) => MeshCore.normalizeMark(mark));
      return insights.forecast(marks, p.target === undefined ? 4.5 : p.target, p.remaining === undefined ? 1 : p.remaining);
    }

    case 'insights.whatIf': {
      const marks = (p.marks || p.payload || []).map((mark) => MeshCore.normalizeMark(mark));
      return insights.whatIf(marks, p.extra || []);
    }

    case 'insights.impact': {
      const marks = (p.marks || p.payload || []).map((mark) => MeshCore.normalizeMark(mark));
      // Как в Rust: метод возвращает массив строк, а не объект-обёртку.
      return insights.subjectImpact(marks, p.limit === undefined ? 5 : p.limit);
    }

    case 'insights.history':
      return insights.historySeries(p.snapshots || history, p.subjectId === undefined ? null : p.subjectId);

    case 'history.list':
      return obj([['count', history.length], ['snapshots', history]]);

    case 'history.append': {
      const snapshot = p.snapshot || p;
      history.push(snapshot);
      return obj([['added', true], ['count', history.length]]);
    }

    case 'history.clear':
      history.length = 0;
      return obj([['cleared', true]]);

    case 'csv.rank': {
      const rows = p.members
        ? MeshCore.buildRankTable(p.members, { names: p.names || {}, meId: p.meId || '' }).map(rankRowJson)
        : (p.rows || []);
      const columns = [
        { key: 'place', title: 'Место', value: (row) => row.place },
        { key: 'name', title: 'Ученик', value: (row) => row.name },
        { key: 'average', title: 'Средний балл', value: (row) => row.average },
        { key: 'placeDelta', title: 'Δ места', value: (row) => row.placeDelta },
        { key: 'averageDelta', title: 'Δ балла', value: (row) => row.averageDelta }
      ];
      const csv = format.toCsv(rows, columns, { title: p.title || 'Рейтинг класса' });
      return obj([['csv', csv], ['rows', rows.length], ['bytes', Buffer.byteLength(csv, 'utf8')]]);
    }

    case 'csv.marks': {
      const rows = (p.marks || p.payload || []).map((mark) => MeshCore.normalizeMark(mark));
      const columns = [
        { key: 'date', title: 'Дата', value: (row) => row.date },
        { key: 'subjectName', title: 'Предмет', value: (row) => row.subjectName },
        { key: 'value', title: 'Оценка', value: (row) => row.value },
        { key: 'weight', title: 'Вес', value: (row) => row.weight }
      ];
      const csv = format.toCsv(rows, columns, { title: p.title || 'Оценки' });
      return obj([['csv', csv], ['rows', rows.length], ['bytes', Buffer.byteLength(csv, 'utf8')]]);
    }

    case 'bench': {
      const js = benchCompare.runJs({ rows: p.students || 26, iterations: p.iterations || 50 });
      const timings = {
        rankTableMs: js.buildMs,
        rankTablePerSecond: Math.round(js.opsPerSecond),
        marksSummaryMs: js.summarizeMs,
        source: 'js-mock'
      };
      return obj([['students', js.rows], ['iterations', js.iterations], ['checksum', 0], ['timings', timings]]);
    }

    case 'cache.stats':
      return obj([['requests', 0], ['cache', { entries: 0 }], ['names', 0]]);

    default: {
      const error = new Error('Неизвестный метод: ' + method);
      error.code = 'unknown-method';
      throw error;
    }
  }
}

function reply(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: { code: 'bad-json', message: String(error.message) } }) + '\n');
    return;
  }
  const id = request && request.id !== undefined ? request.id : null;
  const method = request && request.method ? String(request.method) : '';
  if (method === 'shutdown' || method === 'exit') {
    process.stdout.write(JSON.stringify({ id: id, ok: true, result: { bye: true } }) + '\n');
    process.exit(0);
  }
  try {
    const result = call(method, request ? request.params : {});
    process.stdout.write(JSON.stringify({ id: id, ok: true, result: result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      id: id,
      ok: false,
      error: { code: error.code || 'error', message: error.message || String(error) }
    }) + '\n');
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach((line) => { if (line.trim()) reply(line); });
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { METHODS, call };
