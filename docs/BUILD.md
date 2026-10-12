# Сборка и выпуск

Всё собирается автоматически в GitHub Actions — локально нужен только Node.js
(для веб-версии и desktop) или JDK 17 + Android SDK (для APK).

## Вариант 1. Всё делает CI

1. Запушьте изменения в `main` — запустятся `CI`, `Desktop (Windows + Linux)` и `Android`.
2. Готовые файлы лежат во вкладке **Actions → нужный запуск → Artifacts**:
   - `mesh-ranker-windows` — установщик NSIS (`MeshRanker-1.0.0-win-x64.exe`) и portable-версия;
   - `mesh-ranker-linux` — `MeshRanker-1.0.0-linux-x86_64.AppImage` и `.deb`;
   - `mesh-ranker-android` — `app-debug.apk` и `app-release-unsigned.apk`.
3. Чтобы получить **релиз на GitHub**, поставьте тег:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Тег запускает те же сборки, а собранные файлы автоматически прикрепляются к Release.

## Вариант 2. Локальная сборка

### Веб-версия

```bash
node tools/preview-server.js --demo     # демо-данные, http://localhost:8787
node tools/preview-server.js --port 8080 --host 0.0.0.0   # доступ из локальной сети
```

### Desktop (Windows / Linux)

```bash
cd desktop
npm install
npm start                 # запуск
npm run demo              # запуск с встроенным демо-сервером
npm run dist:win          # Windows: NSIS + portable  (собирать лучше на Windows)
npm run dist:linux        # Linux: AppImage + deb     (собирать лучше на Linux)
```

Что важно знать:

- `npm run sync` копирует `shared/ui` и `shared/core` в `desktop/src/` — это делает
  каждая сборка автоматически, руками синхронизировать не нужно;
- иконка берётся из `desktop/build/icon.png` (electron-builder сам делает из неё `.ico`
  для Windows); чтобы поменять — положите квадратный PNG 512×512 с тем же именем;
- кросс-сборка Windows-установщика на Linux возможна, но надёжнее собирать на целевой ОС
  (в CI так и сделано: Windows-артефакты на `windows-latest`, Linux — на `ubuntu-latest`);
- подпись кода не настроена: Windows SmartScreen и macOS Gatekeeper будут предупреждать
  при первом запуске скачанного файла.

### Android

```bash
cd android
./gradlew testDebugUnitTest   # JVM-тесты ядра и клиента, эмулятор не нужен
./gradlew assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease     # app/build/outputs/apk/release/app-release-unsigned.apk
./gradlew installDebug        # установка на подключённое устройство
```

Требования: JDK 17, Android SDK с `platforms;android-35` и `build-tools;35.0.0`
(Android Studio подставит сама). Gradle wrapper уже в репозитории — отдельно
скачивать Gradle не нужно.

Перед сборкой Gradle копирует общий интерфейс в assets задачей `syncSharedUi`
(`shared/ui` → `app/src/main/assets/ui`). Если вы правили интерфейс, а в приложении
видите старое — выполните `./gradlew syncSharedUi` или `android/tools/sync-ui.sh`.

**Подпись релиза.** Создайте `android/keystore.properties` (файл в `.gitignore`):

```properties
storeFile=/абсолютный/путь/release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

Если файла нет, release-сборка собирается неподписанной — её можно установить
только после ручной подписи (`apksigner`).

## Проверки

```bash
node --test tests/            # модульные тесты ядра
node tools/smoke-preview.js   # полный путь пользователя в демо-режиме
cd android && ./gradlew test  # JVM-тесты Android-ядра
```

Дымовой тест поднимает мок-МЭШ и preview-сервер и проверяет: вход по токену,
профиль, 14 предметов, 26 строк рейтинга с именами и местами, сводку, оценки,
домашние задания, расписание, имена, продление токена и выход.

## Частые вопросы

**Пусто в таблицах, хотя токен есть.** МЭШ отдаёт данные на конкретную дату —
попробуйте кнопки «Сегодня» / «1 сентября» на вкладке «Рейтинг».

**«Токен недействителен».** Войдите заново: «Профиль → Войти заново» или меню
«МЭШ → Войти заново». Токен берётся со страницы
`https://school.mos.ru/v2/token/refresh?roleId=1&subsystem=2`.

**Рейтинг по предмету пуст.** У некоторых предметов нет оценок за выбранный период —
МЭШ возвращает `NO_DATA`.

**Хочу посмотреть интерфейс без аккаунта.** Демо-режим: `--demo` в веб-версии,
`npm run demo` в desktop, пункт меню «Демо-режим» в Android.
