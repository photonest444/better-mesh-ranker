# Настройка CI в GitHub Actions

Workflow-файлы лежат в двух местах, и это важно понимать:

- `ci/` — **источник правды**: обычные текстовые файлы, которые версионируются
  вместе с кодом и обновляются в каждом изменении;
- `.github/workflows/` — рабочий каталог GitHub Actions, куда файлы нужно установить.

Так сделано потому, что GitHub запрещает создавать и изменять файлы в
`.github/workflows` токенам без права **workflows** (например, GitHub App,
подключённому к Arena.ai): push с такими изменениями отклоняется с сообщением
*«refusing to allow a GitHub App to create or update workflow … without
`workflows` permission»*. Правки копятся в `ci/`, а на место ставятся одной
командой с машины (или токена), у которого такое право есть.

Важно: пока файлы не установлены, GitHub Actions выполняет **прежние** проверки.
В частности, задание `rust-core` (сборка и тесты нативного ядра) заработает
только после установки обновлённого `ci.yml`.

## Как установить/обновить workflow

```bash
bash scripts/enable-ci.sh                 # ci/*.yml → .github/workflows/
git add .github/workflows
git commit -m "CI: обновление проверок"
git push
```

Если push снова отклонён — у токена нет права `workflows`. Варианты:

1. Повторить с личной машины или из GitHub Web UI (Add file → Upload files);
2. Переподключить GitHub в Arena с правом на workflows;
3. Оставить как есть: код, тесты и сборки работают, но новые проверки начнут
   действовать только после того, как файлы окажутся в `.github/workflows`.

## Что делают готовые workflow

### `ci.yml` — проверки на каждый push

Три job'а:

1. **`core-and-ui`** — проверки ядра и интерфейса:
   1. **Синтаксис** всех JS-файлов в `shared/`, `tools/`, `tests/`.
   2. **Модульные тесты** — `node --test tests/*.test.js` (ядро, аналитика
      `insights.js`, мост к нативному ядру через мок-бинарник).
   3. **Дымовой тест приложения** — `node tools/smoke-preview.js`: поднимает
      мок-МЭШ и preview-сервер и проходит путь пользователя (вход → профиль →
      предметы → рейтинг → оценки → задания → расписание → имена → продление
      токена → выход), а также проверяет новые модули аналитики и `/api/native`,
      `/api/bench` — 34 проверки.
   4. **Проверка Android-ресурсов** — `node tools/validate-android.js`.
   5. **Проверка секретов** — в репозитории не должно быть файлов с токенами
      (`school-mos-ru.json`, `users_cache.json`, `.preview/session.json`) и
      похожих на JWT литералов.
2. **`rust-core`** — нативное ядро:
   1. `cargo test --workspace` — тесты ядра и CLI (без сети);
   2. `cargo build --release`;
   3. `mesh-rank selftest` — офлайн-самопроверка (12 проверок);
   4. `mesh-rank bench` — бенчмарк не должен падать;
   5. `node tools/check-rust-bridge.js` — запуск `mesh-rank serve` через тот же
      мост, что и приложение, и сверка ответов с эталонным JS-ядром
      (`tools/mock-mesh-rank.js`): рейтинг, оценки, прогноз, влияние, дедлайны, CSV.
3. **`desktop-smoke`** — Electron-хост: синтаксис `main`/`preload`/`tools`,
   сборка нативного ядра в `desktop/bin`, синхронизация общего интерфейса,
   запуск `MeshService` в демо-режиме (рейтинг и оценки должны приходить)
   и проверка, что замер скорости уходит в Rust.

### `desktop.yml` — Windows и Linux

Матрица из двух job'ов: `windows-latest` собирает NSIS-установщик и portable-версию,
`ubuntu-latest` — AppImage и `.deb`. Перед упаковкой собирается нативное ядро
(`node tools/build-rust.js --required` → `desktop/bin/mesh-rank`), и бинарник
попадает внутрь приложения (`resources/bin`). Артефакты загружаются в Actions,
а по тегу `v*` автоматически прикрепляются к релизу.

### `android.yml` — APK

JDK 17 + Android SDK 35, затем `testDebugUnitTest` (JVM-тесты ядра и клиента,
эмулятор не нужен), `assembleDebug` и `assembleRelease`. Артефакты — APK,
по тегу `v*` — в релиз.

## Как выпустить версию

```bash
git tag v1.0.0
git push origin v1.0.0
```

После этого в GitHub Release появятся:

- `MeshRanker-1.0.0-win-x64.exe` (установщик) и portable-версия;
- `MeshRanker-1.0.0-linux-x86_64.AppImage` и `.deb`;
- `app-debug.apk` и `app-release-unsigned.apk`.

Для подписи Android-релиза добавьте секреты репозитория и шаг подписи в
`ci/android.yml` (см. `docs/BUILD.md`), либо используйте
`android/keystore.properties` при локальной сборке.
