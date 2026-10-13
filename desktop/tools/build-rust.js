#!/usr/bin/env node
'use strict';
/*!
 * Mesh Ranker — сборка нативного ядра (Rust) для приложения.
 *
 * Собирает `rust/` в release и кладёт бинарник `mesh-rank` рядом с приложением
 * (`desktop/bin/`), откуда его находит `mesh-core/native.js`:
 *
 *     node tools/build-rust.js            # собрать и скопировать
 *     node tools/build-rust.js --check    # только проверить, есть ли cargo
 *     node tools/build-rust.js --required # упасть, если собрать не удалось
 *
 * Если Rust не установлен, скрипт по умолчанию не валит сборку приложения:
 * без бинарника приложение работает на JS-ядре (функции те же, скорость ниже).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUST_DIR = path.join(ROOT, 'rust');
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
  if (os.homedir()) candidates.push(path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'));
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', shell: false });
    if (probe.status === 0) return { command: candidate, version: (probe.stdout || '').trim() };
  }
  return null;
}

function main() {
  const cargo = findCargo();
  if (!cargo) {
    log('cargo не найден — нативное ядро не собирается, приложение работает на JS-ядре.');
    if (required) process.exit(1);
    if (checkOnly) process.exit(0);
    process.exit(0);
  }
  log(cargo.version + (checkOnly ? ' (только проверка)' : ''));
  if (checkOnly) process.exit(0);

  if (!fs.existsSync(path.join(RUST_DIR, 'Cargo.toml'))) {
    log('нет ' + path.join(RUST_DIR, 'Cargo.toml') + ' — пропускаем');
    if (required) process.exit(1);
    process.exit(0);
  }

  log('cargo build --release');
  const build = spawnSync(cargo.command, ['build', '--release', '--manifest-path', path.join(RUST_DIR, 'Cargo.toml')], {
    stdio: 'inherit',
    cwd: RUST_DIR
  });
  if (build.status !== 0) {
    log('сборка не удалась (код ' + build.status + ')' + (required ? '' : ' — продолжаем на JS-ядре'));
    process.exit(required ? 1 : 0);
  }

  const built = path.join(TARGET_DIR, EXE);
  if (!fs.existsSync(built)) {
    log('бинарник не найден: ' + built);
    process.exit(required ? 1 : 0);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const destination = path.join(OUT_DIR, EXE);
  fs.copyFileSync(built, destination);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  const size = Math.round(fs.statSync(destination).size / 1024);
  log('готово: ' + path.relative(ROOT, destination) + ' (' + size + ' КБ)');
}

main();
