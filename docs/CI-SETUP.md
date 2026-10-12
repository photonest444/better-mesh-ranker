# Настройка CI в GitHub Actions

Workflow-файлы лежат в двух местах:

- `ci/` — **источник правды**, обычные файлы, которые всегда попадают в git;
- `.github/workflows/` — рабочий каталог GitHub Actions, куда их нужно установить.

Так сделано потому, что GitHub запрещает создавать и изменять файлы в
`.github/workflows` токенам без права **workflows** (например, GitHub App,
подключённому к Arena.ai). Если у вашего доступа такое право есть — просто
скопируйте файлы и запушьте.

## Включение (одна команда)

```bash
bash scripts/enable-ci.sh
git add .github/workflows
git commit -m "CI: сборка Windows/Linux/Android"
git push
```

В Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force .github/workflows | Out-Null
Copy-Item ci\*.yml .github/workflows\
git add .github/workflows
git commit -m "CI: сборка Windows/Linux/Android"
git push
```

Если push отклонён с сообщением *«refusing to allow a GitHub App to create or
update workflow … without `workflows` permission»* — у токена нет права
`workflows`. Варианты:

1. Запушить эти файлы со своей машины или из GitHub Web UI (Add file → Upload files);
2. Переподключить GitHub в Arena с правом на workflows;
3. Оставить как есть — код и сборки работают, но автопроверки не запускаются,
   пока файлы не окажутся в `.github/workflows`.

## Что делают готовые workflow

### `ci.yml` — проверки на каждый push

1. **Синтаксис** всех JS-файлов в `shared/`, `tools/`, `tests/`.
2. **Модульные тесты ядра** — `node --test tests/` (токены, нормализация,
   статистика, работа с таблицами, экспорт, автообновление токена на мок-МЭШ).
3. **Дымовой тест приложения** — `node tools/smoke-preview.js`: поднимает
   мок-МЭШ и preview-сервер и проходит путь пользователя (вход → профиль →
   предметы → рейтинг → оценки → задания → расписание → имена → продление
   токена → выход), 26 проверок.
4. **Проверка desktop-хоста** — синтаксис `main`/`preload`/`tools`, синхронизация
   общего интерфейса и запуск `MeshService` в демо-режиме: рейтинг и оценки
   должны реально приходить.
5. **Проверка секретов** — в репозитории не должно быть файлов с токенами
   (`school-mos-ru.json`, `users_cache.json`, `.preview/session.json`) и
   похожих на JWT литералов.

### `desktop.yml` — Windows и Linux

Матрица из двух job'ов: `windows-latest` собирает NSIS-установщик и portable-версию,
`ubuntu-latest` — AppImage и `.deb`. Артефакты загружаются в Actions, а по тегу
`v*` автоматически прикрепляются к релизу.

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
