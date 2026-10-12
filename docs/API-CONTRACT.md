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
до формулировок.

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
