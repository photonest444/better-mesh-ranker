#!/usr/bin/env node
'use strict';
/*!
 * Mesh Ranker — сборка нативного ядра (Rust) для приложения.
 *
 * Собирает `rust/` в release и кладёт бинарник `mesh-rank` рядом с приложением
 * (`desktop/bin/`), откуда его находит `shared/core/native.js`:
 *
 *     node tools/build-rust.js            # собрать и скопировать
 *     node tools/build-rust.js --check    # только проверить, есть ли cargo
 *     node tools/build-rust.js --required # упасть и без cargo тоже
 *
 * Правила простые:
 *   - cargo не найден → приложение работает на JS-ядре, сборка продолжается
 *     (упасть в этом случае можно флагом --required);
 *   - cargo найден, но компиляция не удалась → это ошибка в коде, шаг падает
 *     всегда, а сообщения компилятора печатаются и как аннотации GitHub
 *     (`::error file=…,line=…::…`), чтобы их было видно прямо в интерфейсе CI.
 *
 * Разбор сообщений компилятора вынесен в экспортируемые функции — их проверяет
 * tests/build-rust.test.js, поэтому разметка ошибок не сломается незаметно.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUST_DIR = path.join(ROOT, 'rust');
const MANIFEST = path.join(RUST_DIR, 'Cargo.toml');
const TARGET_DIR = path.join(RUST_DIR, 'target', 'release');
const OUT_DIR = path.join(__dirname, '..', 'bin');
const EXE = process.platform === 'win32' ? 'mesh-rank.exe' : 'mesh-rank';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const required = args.includes('--required');

function log(message) {
  console.log('[rust] ' + message);
}

function findCargo() {
  const candidates = [];
  if (process.env.CARGO) candidates.push(process.env.CARGO);
  candidates.push('cargo');
  if (os.homedir()) {
    candidates.push(path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
    if (probe.status === 0) return { command: candidate, version: (probe.stdout || '').trim() };
  }
  return null;
}

/** Разбирает JSON-поток cargo и возвращает ошибки компилятора. */
function collectErrors(stdout) {
  const errors = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      continue;
    }
    if (message.reason !== 'compiler-message') continue;
    const compiler = message.message;
    if (!compiler || compiler.level !== 'error') continue;
    const span = (compiler.spans || []).find((item) => item.is_primary) || (compiler.spans || [])[0] || null;
    errors.push({
      text: (compiler.message || 'ошибка компиляции').replace(/\r?\n/g, ' '),
      rendered: (compiler.rendered || '').trim(),
      file: span && span.file_name ? path.relative(ROOT, path.resolve(RUST_DIR, span.file_name)) : null,
      line: span && span.line_start ? span.line_start : null,
      column: span && span.column_start ? span.column_start : null
    });
  }
  return errors;
}

/** Печатает ошибки так, чтобы GitHub показал их аннотациями. */
function annotate(errors) {
  if (!errors.length) {
    log('компилятор не оставил разбора — смотрите полный вывод выше');
    console.log('::error::cargo build завершился с ошибкой, но разобрать сообщения не удалось');
    return;
  }
  const unique = [];
  const seen = new Set();
  for (const error of errors) {
    const key = [error.file, error.line, error.column, error.text].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(error);
  }
  const shown = unique.slice(0, 30);
  for (const error of shown) {
    const where = error.file && error.line
      ? ' file=' + error.file + ',line=' + error.line + (error.column ? ',col=' + error.column : '')
      : '';
    const body = (error.rendered || error.text).slice(0, 1400);
    console.log('::error' + where + '::' + body.replace(/\r?\n/g, '%0A'));
  }
  if (unique.length > shown.length) {
    log('аннотациями показаны первые ' + shown.length + ' из ' + unique.length + ' ошибок');
  }
}

function main() {
  const cargo = findCargo();
  if (!cargo) {
    log('cargo не найден — нативное ядро не собирается, приложение работает на JS-ядре.');
    process.exit(required ? 1 : 0);
  }
  log(cargo.version + (checkOnly ? ' (только проверка)' : ''));
  if (checkOnly) process.exit(0);

  if (!fs.existsSync(MANIFEST)) {
    log('нет ' + MANIFEST + ' — пропускаем');
    process.exit(required ? 1 : 0);
  }

  log('cargo build --release');
  const build = spawnSync(cargo.command, ['build', '--release', '--message-format=json', '--manifest-path', MANIFEST], {
    encoding: 'utf8',
    cwd: RUST_DIR,
    maxBuffer: 96 * 1024 * 1024
  });
  if (build.error) {
    log('не удалось запустить cargo: ' + build.error.message);
    process.exit(1);
  }
  if (build.stderr) process.stderr.write(build.stderr);
  const errors = collectErrors(build.stdout);
  for (const error of errors) {
    if (error.rendered) console.log(error.rendered + '\n');
  }
  if (build.status !== 0) {
    log('сборка не удалась (код ' + build.status + '): приложение без нативного ядра останется на JS — исправьте ошибки выше');
    annotate(errors);
    process.exit(1);
  }

  const built = path.join(TARGET_DIR, EXE);
  if (!fs.existsSync(built)) {
    log('бинарник не найден: ' + built);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const destination = path.join(OUT_DIR, EXE);
  fs.copyFileSync(built, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  const size = Math.round(fs.statSync(destination).size / 1024);
  log('готово: ' + path.relative(ROOT, destination) + ' (' + size + ' КБ)');
}

if (require.main === module) {
  main();
}

module.exports = { collectErrors, annotate };
