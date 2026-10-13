'use strict';
/*
 * Тесты моста к нативному ядру: запуск процесса, протокол JSON-lines,
 * таймауты, ошибки и деградация к JS.
 *
 * Настоящий mesh-rank собирается из Rust и в этой среде может отсутствовать,
 * поэтому роль бинарника играет `tools/mock-mesh-rank.js` — эталонная
 * реализация того же протокола на JS-ядре. Тот же код (native.js) в CI
 * запускает и настоящий бинарник, а tools/check-rust-bridge.js сверяет ответы.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const native = require('../shared/core/native.js');
const accelerate = require('../shared/core/accelerate.js');
const benchCompare = require('../shared/core/bench-compare.js');

const MOCK = path.join(__dirname, '..', 'tools', 'mock-mesh-rank.js');

/** Каждый тест начинается с чистого состояния общего моста. */
function reset() {
  native.reset();
  accelerate.reset();
}

// Дочерние процессы не должны жить дольше тестов.
test.after(() => {
  native.reset();
  accelerate.reset();
});

const mockOptions = () => ({
  binary: process.execPath,
  args: [MOCK],
  timeoutMs: 8000,
  force: true
});

test('мост запускает процесс, делает рукопожатие и отвечает на вызовы', async () => {
  reset();
  const accelerator = native.createAccelerator(mockOptions());
  assert.ok(accelerator, 'ускоритель должен создаться при указанном бинарнике');

  const ready = await accelerator.ready();
  assert.strictEqual(ready.available, true);
  assert.strictEqual(ready.engine, 'rust');
  assert.ok(ready.methods >= 10, 'в hello должен быть список методов');

  const board = await accelerator.rankBoard({
    members: [
      { personId: 'a', rank: { averageMarkFive: 4.6, rankPlace: 2 } },
      { personId: 'b', rank: { averageMarkFive: 4.9, rankPlace: 1 } }
    ],
    names: { a: 'Аня', b: 'Боря' },
    meId: 'a'
  });
  assert.strictEqual(board.rows.length, 2);
  assert.strictEqual(board.rows[0].name, 'Боря');
  assert.strictEqual(board.rows[1].isMe, true);
  assert.strictEqual(board.summary.myPlace, 2);

  const plan = await accelerator.forecast([{ value: 5 }, { value: 4 }, { value: 3 }], 4.2, 1);
  assert.strictEqual(plan.status, 'achievable');
  assert.strictEqual(plan.fivesNeeded, 1);

  const csv = await accelerator.csvRank(board.rows, 'Рейтинг класса');
  assert.ok(csv.csv.startsWith('\uFEFF'), 'CSV начинается с BOM (Excel откроет без вопросов)');
  assert.ok(csv.csv.includes(';'));
  assert.strictEqual(csv.rows, 2);

  accelerator.dispose();
  native.reset();
});

test('ускоритель считает на Rust и молча возвращается к JS при ошибке', async () => {
  reset();

  // Ошибка метода (неизвестный метод) — должна привести к JS-расчёту.
  accelerate.attach({
    raw: () => Promise.reject(Object.assign(new Error('нет такого метода'), { code: 'unknown-method' })),
    describe: () => ({ version: '0.0.0' })
  });
  const broken = await accelerate.forecast([{ value: 5 }, { value: 4 }], 4.5, 1);
  assert.strictEqual(broken.engine, 'js');
  assert.strictEqual(broken.fallback, true);
  assert.strictEqual(broken.value.status, 'done');
  assert.strictEqual(accelerate.engine().fallbacks, 1);

  // Настоящий мост поверх мок-бинарника — расчёт уходит в процесс.
  accelerate.reset();
  const accelerator = accelerate.createAccelerator(mockOptions());
  accelerate.attach(accelerator);
  const native1 = await accelerate.deadlines(
    [{ id: 'h1', subjectName: 'Физика', dueDate: '2026-10-13', isDone: false }],
    '2026-10-13'
  );
  assert.strictEqual(native1.engine, 'rust');
  assert.strictEqual(native1.fallback, false);
  assert.strictEqual(native1.value.groups.filter((group) => group.count > 0)[0].key, 'today');

  const missed = await accelerate.run('no-such-method', {}, () => 'js-fallback');
  assert.strictEqual(missed.engine, 'js');
  assert.strictEqual(missed.value, 'js-fallback');

  const engine = accelerate.engine();
  assert.strictEqual(engine.engine, 'rust');
  assert.ok(engine.nativeCalls >= 1, 'счётчик нативных вызовов растёт');
  assert.ok(engine.fallbacks >= 1, 'ошибки ядра учтены как откат к JS');

  accelerator.dispose();
  accelerate.reset();
  native.reset();
});

test('мок-бинарник терпим к мусору и знает про shutdown', async () => {
  reset();
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [MOCK, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });

  child.stdin.write('это не json\n');
  child.stdin.write(JSON.stringify({ id: 1, method: 'hello', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ id: 2, method: 'shutdown', params: {} }) + '\n');

  await new Promise((resolve) => setTimeout(resolve, 400));
  const lines = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.strictEqual(lines[0].ok, false);
  assert.strictEqual(lines[0].error.code, 'bad-json');
  assert.strictEqual(lines[1].ok, true);
  assert.ok(lines[1].result.methods.includes('rank.build'));
  child.kill();
});

test('замер скорости сравнивает движки и не падает без Rust', async () => {
  reset();
  const report = await benchCompare.compare({ rows: 26, iterations: 40, autoDetect: false });
  assert.strictEqual(report.engine, 'js');
  assert.strictEqual(report.rust, null);
  assert.ok(report.js.opsPerSecond > 0);
  assert.ok(/JS/.test(report.note));

  const nativeReport = await benchCompare.compare({
    rows: 26,
    iterations: 40,
    accelerator: accelerate.createAccelerator(mockOptions())
  });
  assert.strictEqual(nativeReport.engine, 'rust');
  assert.ok(nativeReport.rust && nativeReport.rust.perOpMs >= 0);
  assert.ok(nativeReport.speedup === null || typeof nativeReport.speedup === 'number');
  native.reset();
});
