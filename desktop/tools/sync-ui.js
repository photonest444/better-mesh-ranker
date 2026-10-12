#!/usr/bin/env node
'use strict';
/*!
 * Mesh Ranker — сборка desktop-версии из общего кода.
 *
 * Интерфейс и ядро живут в shared/ (один источник правды для Electron и Android),
 * а Electron-сборка должна быть самодостаточной: этот скрипт копирует
 *   shared/ui    → desktop/src/renderer
 *   shared/core  → desktop/src/core
 *   tools/mock-mesh-server.js → desktop/src/core/ (для демо-режима)
 *
 * Запускается автоматически перед `npm start` и перед упаковкой
 * (electron-builder вызывает его через скрипт `prepack`/`dist:*`).
 */

const fs = require('fs');
const path = require('path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..');

const COPY = [
  { from: path.join(repoRoot, 'shared', 'ui'), to: path.join(desktopRoot, 'src', 'renderer') },
  { from: path.join(repoRoot, 'shared', 'core'), to: path.join(desktopRoot, 'src', 'core') },
  { from: path.join(repoRoot, 'tools', 'mock-mesh-server.js'), to: path.join(desktopRoot, 'src', 'core', 'mock-mesh-server.js') }
];

function copyRecursive(from, to, stats) {
  const info = fs.statSync(from);
  if (info.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry), stats);
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  stats.files++;
  stats.bytes += info.size;
}

function main() {
  const stats = { files: 0, bytes: 0 };
  for (const entry of COPY) {
    if (!fs.existsSync(entry.from)) {
      console.error('Не найдено: ' + entry.from);
      process.exit(1);
    }
    copyRecursive(entry.from, entry.to, stats);
  }
  console.log(`Синхронизировано файлов: ${stats.files} (${(stats.bytes / 1024).toFixed(1)} КиБ)`);
  console.log('  shared/ui   → desktop/src/renderer');
  console.log('  shared/core → desktop/src/core');
}

if (require.main === module) main();
module.exports = { main, COPY };
