'use strict';
/*
 * Проверки сборщика нативного ядра (desktop/tools/build-rust.js).
 *
 * Зачем: если компиляция Rust падает, шаг сборки обязан упасть и показать
 * ошибки компилятора аннотациями GitHub. Раньше сборка молча продолжалась,
 * и приложение уезжало к пользователю без нативного ядра — эти тесты следят,
 * чтобы разбор сообщений cargo и разметка аннотаций не сломались.
 *
 * Сам Rust здесь не собирается: поток сообщений cargo подделывается.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  collectErrors,
  annotate
} = require('../desktop/tools/build-rust.js');

function compilerMessage(level, message, span) {
  return JSON.stringify({
    reason: 'compiler-message',
    message: {
      level,
      message,
      rendered: level + ': ' + message + '\n  --> ' + (span ? span.file_name : 'unknown'),
      spans: span ? [span] : []
    }
  });
}

test('collectErrors достаёт ошибки с файлом, строкой и колонкой', () => {
  const stdout = [
    'Compiling mesh-core v1.1.0',
    compilerMessage('warning', 'unused import', { file_name: 'crates/mesh-core/src/util.rs', line_start: 3, column_start: 1, is_primary: true }),
    compilerMessage('error', 'cannot find value `x` in this scope', { file_name: 'crates/mesh-core/src/json.rs', line_start: 12, column_start: 5, is_primary: true }),
    compilerMessage('error', 'mismatched types', { file_name: 'crates/mesh-cli/src/main.rs', line_start: 40, column_start: 9, is_primary: true }),
    '{ это не JSON',
    ''
  ].join('\n');

  const errors = collectErrors(stdout);
  assert.equal(errors.length, 2, 'предупреждения и мусор не считаются ошибками');
  assert.match(errors[0].file, /rust\/crates\/mesh-core\/src\/json\.rs$/, 'путь пересчитан от корня репозитория');
  assert.equal(errors[0].line, 12);
  assert.equal(errors[0].column, 5);
  assert.match(errors[0].text, /cannot find value/);
  assert.match(errors[1].file, /rust\/crates\/mesh-cli\/src\/main\.rs$/);
});

test('collectErrors терпим к пустому и битому потоку', () => {
  assert.deepEqual(collectErrors(''), []);
  assert.deepEqual(collectErrors('просто текст\nбез JSON\n'), []);
  assert.deepEqual(collectErrors(null), []);
});

test('annotate печатает аннотации GitHub с координатами', () => {
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    const same = { text: 'cannot find value `x`', rendered: 'error[E0425]: cannot find value `x`\n  --> crates/mesh-core/src/json.rs:12:5', file: 'rust/crates/mesh-core/src/json.rs', line: 12, column: 5 };
    const other = { text: 'mismatched types', rendered: 'error[E0308]: mismatched types\n  --> crates/mesh-cli/src/main.rs:40:9', file: 'rust/crates/mesh-cli/src/main.rs', line: 40, column: 9 };
    annotate([same, same, other]);
  } finally {
    console.log = original;
  }
  const annotations = printed.filter((line) => line.startsWith('::error'));
  assert.equal(annotations.length, 2, 'одна и та же ошибка не повторяется дважды');
  assert.match(annotations[0], /^::error file=rust\/crates\/mesh-core\/src\/json\.rs,line=12,col=5::/);
  assert.match(annotations[0], /error\[E0425\]/);
  assert.match(annotations[1], /^::error file=rust\/crates\/mesh-cli\/src\/main\.rs,line=40,col=9::/);
  assert.ok(!annotations[0].includes('\n'), 'переносы строк заменены на %0A');
});

test('annotate без разобранных ошибок не молчит', () => {
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    annotate([]);
  } finally {
    console.log = original;
  }
  assert.ok(
    printed.some((line) => line.startsWith('::error::')),
    'если разобрать не удалось, всё равно сообщаем об ошибке'
  );
});
