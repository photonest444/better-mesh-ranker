#!/usr/bin/env node
/**
 * validate-android.js — статическая проверка Android-модуля без сборки.
 *
 * Проверяет то, на чём обычно падает AAPT/компилятор:
 *   1) все ссылки @string/@color/@style/@drawable/@layout/@menu/@xml/@array/
 *      @dimen/@bool/@integer/@plurals из разметки, манифеста и Kotlin (R.*)
 *      действительно объявлены в res/;
 *   2) у каждого <item> в темах корректное имя: android:-атрибут существует
 *      как системный, или это атрибут проекта (ищите app: / colorPrimary);
 *   3) не используется несуществующий android:showAsAction (он только app:);
 *   4) каждый <activity>/<service>/<receiver> в манифесте ссылается на
 *      класс, который есть в Kotlin-исходниках;
 *   5) build.gradle.kts включает нужные зависимости (viewBinding, материал).
 *
 * Запуск: node tools/validate-android.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const androidDir = path.join(root, 'android');
const appDir = path.join(androidDir, 'app');
const mainDir = path.join(appDir, 'src', 'main');
const resDir = path.join(mainDir, 'res');
const javaDir = path.join(mainDir, 'java');

const errors = [];
const warnings = [];
let checks = 0;

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function ok() {
  checks += 1;
}

function walk(dir, filter, found) {
  found = found || [];
  if (!fs.existsSync(dir)) return found;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === '.gradle' || entry.name === 'assets') return;
      walk(full, filter, found);
    } else if (!filter || filter(full)) {
      found.push(full);
    }
  });
  return found;
}

// ---------------------------------------------------------------- ресурсы ---

const valuesFiles = resourceDirsRaw('values');

function resourceDirsRaw(kind) {
  if (!fs.existsSync(resDir)) return [];
  return fs.readdirSync(resDir, { withFileTypes: true })
    .filter(function (entry) {
      return entry.isDirectory() && (entry.name === kind || entry.name.indexOf(kind + '-') === 0);
    })
    .reduce(function (acc, entry) {
      return acc.concat(walk(path.join(resDir, entry.name), function (f) { return /\.xml$/.test(f); }, []));
    }, []);
}
const valueText = valuesFiles.map(function (file) { return fs.readFileSync(file, 'utf8'); }).join('\n');

// Объявленные ресурсы: значение -> набор имён
const declared = {
  string: [],
  color: [],
  style: [],
  drawable: [],
  layout: [],
  menu: [],
  xml: [],
  array: [],
  dimen: [],
  bool: [],
  integer: [],
  plurals: [],
  font: [],
  anim: [],
  mipmap: []
};

valueText.replace(/<(string|color|style|array|string-array|integer-array|dimen|bool|integer|plurals)\b[^>]*\bname="([^"]+)"/g,
  function (all, tag, name) {
    const kind = tag === 'string-array' ? 'array' : tag === 'integer-array' ? 'array' : tag;
    if (declared[kind]) declared[kind].push(name);
    return all;
  });

// Каталоги ресурсов бывают с квалификаторами: drawable-v24, mipmap-anydpi-v26 и т. п.
function resourceDirs(kind) {
  if (!fs.existsSync(resDir)) return [];
  return fs.readdirSync(resDir, { withFileTypes: true })
    .filter(function (entry) {
      return entry.isDirectory() && (entry.name === kind || entry.name.indexOf(kind + '-') === 0);
    })
    .map(function (entry) { return path.join(resDir, entry.name); });
}

['drawable', 'layout', 'menu', 'xml', 'font', 'anim', 'mipmap', 'raw'].forEach(function (kind) {
  if (!declared[kind]) declared[kind] = [];
  resourceDirs(kind).forEach(function (dir) {
    walk(dir, function (f) { return /\.(xml|png|webp|jpg|jpeg|svg|ttf|otf|json)$/.test(f); }, [])
      .forEach(function (file) {
        const name = path.basename(file).replace(/\.[^.]+$/, '');
        if (declared[kind].indexOf(name) === -1) declared[kind].push(name);
      });
  });
});

const declaredSets = {};
Object.keys(declared).forEach(function (kind) {
  declaredSets[kind] = new Set(declared[kind]);
});

// Ссылки @kind/name в XML
const xmlFiles = walk(resDir, function (f) { return /\.xml$/.test(f); });
xmlFiles.push(path.join(mainDir, 'AndroidManifest.xml'));
xmlFiles.filter(function (f) { return fs.existsSync(f); }).forEach(function (file) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  const re = /@(?:\+)?(string|color|style|drawable|layout|menu|xml|array|dimen|bool|integer|plurals|font|anim|mipmap)\/([A-Za-z0-9_.]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1];
    const name = m[2];
    if (name.indexOf('.') !== -1 && kind === 'style') {
      // Стиль-родитель вида Theme.Material3.DayNight — не наш ресурс
      if (valueText.indexOf('name="' + name + '"') === -1) continue;
    }
    if (!declaredSets[kind] || !declaredSets[kind].has(name)) {
      fail(rel + ': ресурс @' + kind + '/' + name + ' не объявлен в res/');
    } else {
      ok();
    }
  }
});

// Ссылки R.* в Kotlin
const kotlinFiles = walk(javaDir, function (f) { return /\.kt$/.test(f); });
kotlinFiles.forEach(function (file) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  const re = /\bR\.(string|color|style|drawable|layout|menu|xml|array|dimen|bool|integer|plurals|font|anim|mipmap|id)\.([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const kind = m[1];
    const name = m[2];
    if (kind === 'id') continue; // id объявляются в разметке, тут не проверяем
    if (!declaredSets[kind] || !declaredSets[kind].has(name)) {
      fail(rel + ': R.' + kind + '.' + name + ' не объявлен в res/');
    } else {
      ok();
    }
  }
});

// ------------------------------------------------------------ манифест ---

const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) {
  fail('нет AndroidManifest.xml');
} else {
  const manifest = fs.readFileSync(manifestPath, 'utf8');

  // Классы активности/сервиса должны существовать в Kotlin
  const classes = new Set();
  kotlinFiles.forEach(function (file) {
    const text = fs.readFileSync(file, 'utf8');
    const pkgMatch = text.match(/^package\s+([\w.]+)/m);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    const re = /\b(?:class|object|interface)\s+([A-Z][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(text))) classes.add(pkg + '.' + m[1]);
  });

  const re = /<(?:\w+\.)?(activity|service|receiver|provider)\b[^>]*android:name="([^"]+)"/g;
  let m;
  while ((m = re.exec(manifest))) {
    const component = m[1];
    let name = m[2];
    if (name.charAt(0) === '.') name = 'ru.meshrating.app' + name;
    if (name.indexOf('.') === -1) name = 'ru.meshrating.app.' + name;
    if (!classes.has(name)) {
      fail('AndroidManifest.xml: ' + component + ' ' + name + ' не найден в Kotlin-исходниках');
    } else {
      ok();
    }
  }

  const pkgAttr = manifest.match(/\bpackage="([^"]+)"/);
  if (pkgAttr && pkgAttr[1] !== 'ru.meshrating.app') {
    fail('AndroidManifest.xml: package=' + pkgAttr[1] + ', а ожидается ru.meshrating.app');
  }

  // Application-класс
  const appName = manifest.match(/<application\b[^>]*android:name="([^"]+)"/);
  if (appName) {
    let name = appName[1].charAt(0) === '.' ? 'ru.meshrating.app' + appName[1] : appName[1];
    if (!classes.has(name)) fail('AndroidManifest.xml: класс Application ' + name + ' не найден');
    else ok();
  }
}

// -------------------------------------------------------------- атрибуты ---

const menuFiles = walk(path.join(resDir, 'menu'), function (f) { return /\.xml$/.test(f); }, []);
menuFiles.forEach(function (file) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  if (/\bandroid:showAsAction=/.test(text)) {
    fail(rel + ': android:showAsAction не существует — нужен app:showAsAction (xmlns:app)');
  } else {
    ok();
  }
  const ids = text.match(/android:id="@\+id\/([A-Za-z0-9_]+)"/g) || [];
  if (!ids.length) warn(rel + ': нет ни одного пункта меню с android:id');
});

// Атрибуты тем: android:-префикс должен быть системным атрибутом
const SYSTEM_ATTR = new RegExp('^(colorPrimary|colorPrimaryDark|colorAccent|colorSecondary|colorSurface|colorOnSurface|' +
  'windowBackground|windowLightStatusBar|statusBarColor|navigationBarColor|windowNoTitle|windowActionBar|' +
  'windowSoftInputMode|textColorPrimary|textColorSecondary|fontFamily|windowLightNavigationBar|' +
  'colorBackground|colorError|colorOnPrimary|colorOnBackground|windowLayoutInDisplayCutoutMode)$');

valueText.replace(/<style\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/style>/g, function (all, styleName, body) {
  body.replace(/<item\s+name="android:([A-Za-z0-9_]+)"/g, function (line, attr) {
    if (!SYSTEM_ATTR.test(attr)) {
      warn('тема ' + styleName + ': android:' + attr + ' может не существовать как системный атрибут');
    } else {
      ok();
    }
    return line;
  });
  return all;
});

// --------------------------------------------------------------- сборка ---

const gradlePath = path.join(appDir, 'build.gradle.kts');
if (!fs.existsSync(gradlePath)) {
  fail('нет android/app/build.gradle.kts');
} else {
  const gradle = fs.readFileSync(gradlePath, 'utf8');
  if (!/viewBinding\s*=\s*true/.test(gradle)) fail('build.gradle.kts: viewBinding не включён, а активности используют binding');
  else ok();
  if (!/namespace\s*=\s*"ru\.meshrating\.app"/.test(gradle)) warn('build.gradle.kts: namespace не ru.meshrating.app');
  if (!/compileSdk\s*=\s*35/.test(gradle)) warn('build.gradle.kts: compileSdk не 35');
  if (!/syncSharedUi/.test(gradle)) fail('build.gradle.kts: нет задачи syncSharedUi (общий интерфейс не попадёт в assets)');
  else ok();
  const catalogPath = path.join(androidDir, 'gradle', 'libs.versions.toml');
  const catalog = fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : '';
  const depsText = gradle + '\n' + catalog;
  [['material', /material/], ['work-runtime-ktx', /work-runtime-ktx/], ['security-crypto', /security-crypto/]]
    .forEach(function (pair) {
      if (!pair[1].test(depsText)) fail('нет зависимости ' + pair[0] + ' (ни в build.gradle.kts, ни в libs.versions.toml)');
      else ok();
    });
  ['androidx.appcompat', 'kotlinx-coroutines'].forEach(function (dep) {
    if (depsText.indexOf(dep) === -1) warn('возможно, нет зависимости ' + dep);
  });
}

// ------------------------------------------------ общий интерфейс в assets ---

const assetsUi = path.join(mainDir, 'assets', 'ui', 'index.html');
const sharedUi = path.join(root, 'shared', 'ui', 'index.html');
if (fs.existsSync(sharedUi) && !fs.existsSync(assetsUi)) {
  warn('assets/ui/index.html нет — он появится при сборке (syncSharedUi); при ручной сборке запустите android/tools/sync-ui.sh');
}

// ------------------------------------------------------------------ итог ---

console.log('Проверок: ' + checks + ', предупреждений: ' + warnings.length + ', ошибок: ' + errors.length);
warnings.forEach(function (message) { console.log('  ! ' + message); });
errors.forEach(function (message) { console.log('  ✗ ' + message); });

if (errors.length) {
  console.log('Проверка Android-ресурсов не пройдена');
  process.exit(1);
}
console.log('Проверка Android-ресурсов пройдена');
