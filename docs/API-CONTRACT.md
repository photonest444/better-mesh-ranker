# Контракт между интерфейсом и платформой

Общий интерфейс (`shared/ui`) ничего не знает о том, где он запущен. Он общается с
платформенным слоем (`shared/ui/platform.js`), а тот — с одной из трёх реализаций:

| Платформа | Транспорт | Реализация |
| --- | --- | --- |
| Electron (Windows/Linux) | IPC через `contextBridge` | `desktop/src/main/mesh-service.js` |
| Android | `@JavascriptInterface` | `android/.../MeshApi.kt` |
| Web / preview | REST `/api/*` | `tools/preview-server.js` |

Все три реализации используют **одно и то же ядро** (`shared/core/mesh-core.js` и его
Kotlin-порт `MeshCore.kt`), поэтому разбор данных и автообновление токена совпадают
до формулировок. У «горячих» вычислений (рейтинг, сводки, прогноз, дедлайны, CSV) есть
вторая, нативная реализация на Rust — `mesh-rank serve`; интерфейс общается с ней через
`shared/core/native.js` и `shared/core/accelerate.js` (см. раздел «Нативное ядро»).

## Формат вызова

**Единственный вход:** `invoke(method, payload) → Promise<data>`

Успех:

```json
{ "ok": true, "data": { } }
```

Ошибка:

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "Токен недействителен…", "raw": "…" } }
```

Коды ошибок: `network`, `timeout`, `unauthorized`, `forbidden`, `not-found`, `invalid-json`,
`bad-token`, `http-<код>`, `exhausted`, `no-student`, `demo-disabled`, `login-cancelled`, `login-timeout`.

Мосты платформы:

- Electron: `window.meshDesktop.invoke(method, payload)`; события — `meshDesktop.on(channel, handler)`
- Android: `window.MeshNative.invoke(id, method, payloadJson)` → ответ `window.__meshResolve(id, json)`
- Общие события страницы: `window.__meshEvent(channel, json)`

## Методы

| Метод | Параметры | Что возвращает |
| --- | --- | --- |
| `state` | — | состояние сессии (см. ниже) |
| `signIn` | `{ token }` | новое состояние сессии |
| `signOut` | — | состояние без токена |
| `refreshToken` | — | состояние с новым токеном |
| `startMeshLogin` | — | `{ token, source }` (Electron/Android; в web — `null`) |
| `selectStudent` | `{ studentId }` | состояние с другим активным учеником |
| `profile` | — | `{ parent, children, defaultChild, hash }` |
| `subjects` | `{ studentId, date }` | `{ date, personId, subjects: [...] }` |
| `subjectMarks` | `{ studentId }` | `{ marks: [...] }` |
| `rank` | `{ studentId, personId, date, subjectId, subjectName }` | `{ rows, summary, date, subjectId, subjectName }` |
| `marks` | `{ studentId, from, to }` | `{ from, to, marks: [...], summary }` |
| `homeworks` | `{ studentId, from, to }` | `{ from, to, homeworks: [...] }` |
| `schedule` | `{ studentId, date }` | `{ date, lessons: [...] }` |
| `names` | `{ personIds: "id,id" }` | `{ names: { id: "Фамилия Имя" } }` |
| `demoToken` | — | `{ token }` (только в демо-режиме) |
| `clearCache` | — | `{ cleared: true }` |
| `settingsGet` / `settingsSet` | `{ …настройки }` | текущие настройки |
| `saveFile` | `{ fileName, text }` | `{ saved, filePath }` |
| `ping` | — | `{ ok }` |
| `loginUrl` | — | `{ url }` |
| `native` | — | `{ available, engine, version, methods, calls, errors, reason }` — состояние нативного ядра |
| `bench` | `{ rows, iterations, marks }` | `{ engine, js, rust, speedup, note }` — сравнение скорости JS и Rust |

## Состояние сессии (`state`)

```json
{
  "demo": false,
  "platform": "android",
  "authenticated": true,
  "token": { "present": true, "kind": "jwt", "mask": "eyJhbG…c1w5", "expiresAt": 4102444800000, "expired": false },
  "loginUrl": "https://school.mos.ru/v2/token/refresh?roleId=1&subsystem=2",
  "profile": { "parent": { "name": "…" }, "children": [ … ] },
  "children": [
    { "id": "17234613", "personId": "uuid", "name": "Демидов Пётр", "shortName": "Пётр",
      "className": "7 «Б»", "schoolName": "ГБОУ Школа № 1234" }
  ],
  "activeStudentId": "17234613",
  "lastRefresh": 1791789600000,
  "storage": "encrypted-shared-preferences",
  "host": "https://school.mos.ru",
  "settings": { "theme": "auto", "pageSize": 25 }
}
```

## Таблица рейтинга (`rank`)

```json
{
  "date": "2026-10-12",
  "subjectId": "1",
  "subjectName": "Алгебра",
  "rows": [
    {
      "index": 0, "personId": "uuid", "place": 1, "name": "Иванов Иван",
      "average": 4.82, "previousAverage": 4.6, "previousPlace": 2,
      "placeDelta": 1, "averageDelta": 0.22, "trendDirection": 1,
      "status": "TOP", "color": "green", "isMe": false, "rankLabel": "#1"
    }
  ],
  "summary": {
    "total": 26, "withMarks": 26,
    "classAverage": 4.05, "classMedian": 4.02, "classMin": 3.1, "classMax": 4.9,
    "myAverage": 4.4, "myPlace": 7, "myRow": { … }, "myTrend": 1, "myDelta": 0.25,
    "leader": { "name": "…", "average": 4.9, "personId": "uuid" },
    "gapToLeader": 0.5, "gapToNext": 0.05,
    "aheadOfMe": 6, "behindMe": 19, "aboveClassAverage": true,
    "bestPlace": 1, "worstPlace": 26,
    "histogram": [ { "from": 5.0, "to": 5.0, "label": "5.0–5.0", "count": 2 } ]
  }
}
```

## Оценки, задания, расписание

- оценка: `{ id, value, subjectId, subjectName, controlForm, weight, date, comment, isExam }`
- задание: `{ id, subjectId, subjectName, description, assignedOn, dueDate, isDone, attachments }`
- урок: `{ date, number, begin, end, subject, teacher, room, homework, mark, isCancelled }`
- сводка оценок: `{ count, withValue, average, weightedAverage, median, best, worst, bySubject, byValue, lastMark }`

## Сеть МЭШ (за кулисами)

| Назначение | Метод |
| --- | --- |
| Профиль родителя и дети | `GET /api/family/web/v1/profile` |
| Имя ученика | `GET /api/gamification/v1/profiles?personId=` |
| Предметы | `GET /api/ej/rating/v1/rank/subjects?date=&personId=` |
| Рейтинг класса | `GET /api/ej/rating/v1/rank/class?personId=&date=&subjectId=` |
| Оценки | `GET /api/family/web/v1/marks?student_id=&from=&to=` |
| Итоговые оценки | `GET /api/family/web/v1/subject_marks?student_id=` |
| Домашние задания | `GET /api/family/web/v1/homeworks?student_id=&from=&to=` |
| Расписание | `GET /api/family/web/v1/schedule?student_id=&date=` |
| Продление токена | `GET /v2/token/refresh?roleId=1&subsystem=2` |

Заголовки: `Authorization: Bearer <токен>` **и** `Auth-Token: <токен>`,
`X-Mes-RoleId: 1`, `X-Mes-Subsystem: familyweb`, `Profile-Type: student`,
`Profile-Id: <id ученика>`.

Ответ 401 → автоматическое продление токена и один повтор запроса.

## Нативное ядро (Rust): `mesh-rank`

Тот же контракт, но реализованный на Rust без внешних зависимостей
(`rust/crates/mesh-core` + `rust/crates/mesh-cli`). Используется как:

1. **CLI** — `mesh-rank selftest`, `rank`, `subjects`, `marks`, `homeworks`,
   `schedule`, `insights`, `history`, `csv`, `bench`, `state`, `token`;
2. **мост для Node** — `mesh-rank serve`: одна строка JSON на запрос.

### Протокол JSON-lines

```text
→ {"id":1,"method":"rank.build","params":{"members":[…],"names":{…},"meId":"uuid"}}
← {"id":1,"ok":true,"result":{"rows":[…],"summary":{…}}}
← {"id":1,"ok":false,"error":{"code":"unknown-method","message":"Неизвестный метод: …"}}
```

- `id` возвращается как есть (в приложении это `js<N>`);
- пустая строка игнорируется, битая JSON-строка даёт `bad-json` и процесс продолжает работу;
- `shutdown`/`exit` (или закрытие stdin) корректно завершают процесс;
- в stdout попадают **только** JSON-ответы, диагностика идёт в stderr.

### Методы

| Метод | Параметры | Результат |
| --- | --- | --- |
| `hello` | — | `{ name, engine:"rust", version, methods:[34], transport, loginUrl, protocol }` |
| `state` | — | состояние сессии (как в платформенном контракте) |
| `signIn` / `signOut` / `refreshToken` / `selectStudent` | как у платформы | состояние сессии |
| `profile` / `subjects` / `subjectMarks` / `rank` / `marks` / `homeworks` / `schedule` / `names` / `ping` | как у платформы | те же структуры, что и в JS-ядре |
| `token.describe` | `{ token }` | `{ present, kind, mask, expiresAt, expired, … }` |
| `token.extract` | `{ text }` | `{ token }` |
| `stats.describe` | `{ values:[…] }` | `{ count, mean, median, min, max, stdDev, p25, p75 }` |
| `rank.build` | `{ members, names, meId, date, subjectId, subjectName }` | `{ rows, summary }` (форма — как в разделе «Таблица рейтинга») |
| `marks.summarize` | `{ marks }` | `{ marks, summary }` |
| `homeworks.normalize` / `schedule.normalize` | `{ payload }` | `{ homeworks }` / `{ lessons }` |
| `homeworks.deadlines` | `{ homeworks }` или `{ payload }`, `reference` | `{ reference, total, done, undone, overdue, progress, groups, byDay, next, nextUpcoming }` |
| `insights.history` | `{ snapshots, subjectId }` | серия: `{ count, points, placeDelta, averageDelta, bestPlace, sparkline, placeSparkline, trend, improved }` |
| `insights.forecast` | `{ marks, target, remaining }` | `{ status: done/achievable/unreachable, fivesNeeded, neededAverage, maxPossible, average, weightedAverage, gap, text }` |
| `insights.whatIf` | `{ marks, extra:[…] }` | `{ before, after, delta, count, added }` |
| `insights.impact` | `{ marks, limit }` | `[ { subjectId, subjectName, count, average, deltaIfFive, share } ]` |
| `csv.rank` / `csv.marks` | `{ rows | members, names, meId, title }` / `{ marks, title }` | `{ csv, rows, bytes }` (BOM, `;`, CRLF — Excel открывает без вопросов) |
| `history.list` / `history.append` / `history.clear` | — / снимок / — | `{ count, snapshots }` / `{ added, count }` / `{ cleared }` |
| `cache.stats` | — | `{ requests, cache, names }` |
| `bench` | `{ students, marks, iterations }` | `{ students, iterations, checksum, timings: { buildMs, serializeMs, parseMs, rankTableMs, rankTablePerSecond, marksSummaryMs, jsonStringifyMs, csvMs, describeMs } }` |

### Как приложение это использует

- `shared/core/native.js` — ищет бинарник (`desktop/bin`, `rust/target/{release,debug}`,
  `MESH_RANKER_RUST_BIN`, `PATH`), запускает `serve`, делает рукопожатие и помнит состояние;
  при любой проблеме (нет бинарника, ошибка, таймаут) вызовы не выполняются, а интерфейс
  продолжает работать на JS;
- `shared/core/accelerate.js` — обёртка с деградацией: `run(method, params, localFn)`
  возвращает `{ value, engine, ms, fallback }`; счётчики (`nativeCalls`, `fallbacks`,
  оценка сэкономленных миллисекунд) показываются в настройках;
- `shared/core/bench-compare.js` — замер «JS против Rust» на одинаковых данных:
  `{ engine, js: { perOpMs, opsPerSecond }, rust: { perOpMs, opsPerSecond, timings }, speedup, note }`.

### Мост в веб-версии

`tools/preview-server.js` отдаёт состояние движка и замер по REST:

```text
GET /api/native                          → { available, engine, version, reason, … }
GET /api/bench?rows=26&iterations=200    → { engine, js, rust, speedup, note }
```

### Проверки

- `mesh-rank selftest` — 12 офлайн-проверок (без сети);
- `node tools/mock-mesh-rank.js` — эталонная JS-реализация того же протокола;
- `node tools/check-rust-bridge.js` — запускает настоящий бинарник через мост и сверяет
  ответы с эталоном: рейтинг, оценки, прогноз, влияние, дедлайны, CSV, бенчмарк (18 проверок);
- `tests/native-bridge.test.js` — протокол, таймауты, ошибки и деградация к JS
  (на мок-бинарнике, поэтому Rust для этих тестов не нужен).
