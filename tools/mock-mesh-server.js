/*!
 * Mesh Ranker — мок-сервер МЭШ.
 *
 * Зачем нужен:
 *   1) автотесты ядра без доступа к реальному school.mos.ru;
 *   2) демо-режим, в котором интерфейс можно посмотреть, не имея аккаунта МЭШ.
 *
 * Данные генерируются детерминированно (seed), поэтому таблицы в демо-режиме
 * всегда одинаковые — удобно и для скриншотов, и для проверок.
 *
 * Запуск: node tools/mock-mesh-server.js --port 8790
 */
'use strict';

const http = require('http');
const { URL } = require('url');

// ------------------------------------------------------------- генерация ----

/** Быстрый детерминированный ГПСЧ (mulberry32). */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = ['Абрамов', 'Белова', 'Виноградов', 'Гусева', 'Дмитриев', 'Ершова', 'Жукова', 'Зайцев',
  'Иванова', 'Кузнецов', 'Лебедева', 'Морозов', 'Никитина', 'Орлов', 'Петрова', 'Романов',
  'Смирнова', 'Тимофеев', 'Ульянова', 'Фролова', 'Харитонов', 'Цветкова', 'Чернов', 'Шилова',
  'Щербаков', 'Юдина', 'Яковлев'];
const FIRST_M = ['Артём', 'Максим', 'Иван', 'Дмитрий', 'Егор', 'Кирилл', 'Никита', 'Александр', 'Пётр', 'Лев'];
const FIRST_F = ['Анна', 'Мария', 'София', 'Ева', 'Полина', 'Дарья', 'Виктория', 'Ксения', 'Алиса', 'Вера'];
const MIDDLE_M = ['Алексеевич', 'Сергеевич', 'Дмитриевич', 'Иванович', 'Павлович'];
const MIDDLE_F = ['Алексеевна', 'Сергеевна', 'Дмитриевна', 'Ивановна', 'Павловна'];
const TEACHERS = ['Соколова И. П.', 'Гаврилов А. Н.', 'Мельникова О. В.', 'Ткачук Д. С.', 'Васильева Е. А.'];
const ROOMS = ['204', '211', '306', 'каб. 118', 'спортзал', 'актовый зал'];

const SUBJECTS = [
  { id: 1, name: 'Алгебра', kind: 'exact' },
  { id: 2, name: 'Геометрия', kind: 'exact' },
  { id: 3, name: 'Русский язык', kind: 'human' },
  { id: 4, name: 'Литература', kind: 'human' },
  { id: 5, name: 'Английский язык', kind: 'human' },
  { id: 6, name: 'История', kind: 'human' },
  { id: 7, name: 'Обществознание', kind: 'human' },
  { id: 8, name: 'География', kind: 'natural' },
  { id: 9, name: 'Биология', kind: 'natural' },
  { id: 10, name: 'Физика', kind: 'exact' },
  { id: 11, name: 'Химия', kind: 'natural' },
  { id: 12, name: 'Информатика', kind: 'exact' },
  { id: 13, name: 'ОБЖ', kind: 'human' },
  { id: 14, name: 'Физическая культура', kind: 'sport' }
];

const CONTROL_FORMS = ['Контрольная работа', 'Самостоятельная работа', 'Ответ на уроке', 'Домашняя работа', 'Диктант', 'Тест', 'Проект', 'Зачёт'];

const HOMEWORK_TEMPLATES = [
  'Параграф {p}, вопросы 1–4 письменно',
  'Упражнение {p} в рабочей тетради',
  'Прочитать текст на стр. {p}, выписать определения',
  'Подготовить сообщение по теме урока',
  'Решить задачи {p}–{p2}',
  'Составить план ответа по теме',
  'Выучить формулы и правила со стр. {p}',
  'Выполнить тест в электронном журнале',
  'Написать сочинение-миниатюру (не менее 100 слов)',
  'Подготовиться к практической работе'
];

/** Мини-«личность» ученика: сила по каждому предмету. */
function makeStudent(random, index) {
  const female = random() > 0.5;
  const lastName = SURNAMES[index % SURNAMES.length] + (female ? 'а' : '');
  const firstName = (female ? FIRST_F : FIRST_M)[Math.floor(random() * (female ? FIRST_F.length : FIRST_M.length))];
  const middleName = (female ? MIDDLE_F : MIDDLE_M)[Math.floor(random() * MIDDLE_M.length)];
  const base = 3.15 + random() * 1.6; // общая «сила» 3.15 … 4.75
  const profile = {};
  SUBJECTS.forEach((subject) => {
    const tilt = subject.kind === 'exact' ? 0.25 : subject.kind === 'human' ? -0.1 : 0;
    profile[subject.id] = Math.max(2.3, Math.min(5, base + tilt + (random() - 0.5) * 1.1));
  });
  return {
    personId: `p-${String(index + 1).padStart(3, '0')}-${(index * 7919 % 1000).toString(36)}`,
    lastName,
    firstName,
    middleName,
    female,
    profile
  };
}

function makeClass(seed, size) {
  const random = makeRandom(seed);
  const students = [];
  for (let i = 0; i < size; i++) students.push(makeStudent(random, i));
  return students;
}

/** Оценка с шумом вокруг «силы» ученика по предмету. */
function markFor(random, ability, day) {
  const noise = (random() - 0.42) * 1.15;
  const seasonal = Math.sin(day / 14) * 0.18;
  let value = Math.round(ability + noise + seasonal);
  if (value > 5) value = 5;
  if (value < 2) value = 2;
  return value;
}

function averageOf(marks) {
  if (!marks.length) return null;
  const sum = marks.reduce((acc, m) => acc + m, 0);
  return Math.round((sum / marks.length) * 100) / 100;
}

function iso(date) {
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function parseIso(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return new Date();
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ------------------------------------------------------------ состояние ----

/**
 * @param {{seed?:number, classSize?:number, students?:Array}} [options]
 */
function createDemo(seed, classSize) {
  const random = makeRandom(seed || 20261012);
  const students = makeClass(seed || 20261012, classSize || 26);

  // Приводим идентификаторы к «настоящим»: в профиле ребёнок опознаётся по
  // contingent_guid, и именно это значение приходит в рейтинг как personId.
  const myIndex = Math.min(12, students.length - 1);
  students[myIndex].personId = UUID_ME;
  if (students.length > 1) students[0].personId = UUID_SIBLING;
  const me = students[myIndex];

  const demo = {
    random,
    students,
    me,
    /** История оценок по каждому ученику: {personId: {subjectId: [{value, date, weight, form}]}} */
    marks: {},
    /** Токены: сколько запросов «живёт» каждый токен. */
    tokenLifetime: 3,
    tokenCounter: 0,
    issuedTokens: new Set(['mock-token-1']),
    tokenUses: { 'mock-token-1': 0 }
  };

  const today = new Date();
  const yearStart = new Date(today.getMonth() >= 7 ? today.getFullYear() : today.getFullYear() - 1, 8, 1);

  students.forEach((student) => {
    demo.marks[student.personId] = {};
    SUBJECTS.forEach((subject) => {
      const list = [];
      const ability = student.profile[subject.id];
      const lessons = 3 + Math.floor(random() * 7);
      for (let i = 0; i < lessons; i++) {
        const dayOffset = Math.floor((yearStart.getTime() + i * 9 * 86400000 - yearStart.getTime()) / 86400000);
        const date = new Date(yearStart.getTime() + dayOffset * 86400000);
        if (date > today) continue;
        list.push({
          value: markFor(random, ability, dayOffset),
          date: iso(date),
          weight: [1, 1, 1, 2, 3][Math.floor(random() * 5)],
          form: CONTROL_FORMS[Math.floor(random() * CONTROL_FORMS.length)],
          comment: random() > 0.85 ? 'Были недочёты в оформлении' : ''
        });
      }
      demo.marks[student.personId][subject.id] = list;
    });
  });

  return demo;
}

/** Средние оценки ученика: за всё время и за период [from, to]. */
function averagesFor(demo, personId, subjectId, from, to) {
  const perSubject = demo.marks[personId] || {};
  const result = {};
  SUBJECTS.forEach((subject) => {
    if (subjectId && Number(subjectId) !== subject.id) return;
    const list = (perSubject[subject.id] || []).filter((m) => (!from || m.date >= from) && (!to || m.date <= to));
    result[subject.id] = averageOf(list.map((m) => m.value));
  });
  return result;
}

// -------------------------------------------------------------- HTTP API ----

const UUID_ME = '11111111-1111-4111-8111-111111111111';
const UUID_SIBLING = '22222222-2222-4222-8222-222222222222';

/** Числовой id ребёнка из профиля → personId (contingent_guid) в демо-данных. */
function personIdForStudentId(demo, studentId) {
  if (String(studentId) === '17234614') return demo.students[0].personId;
  return demo.me.personId;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * Создаёт мок-сервер МЭШ.
 * @param {{seed?:number, classSize?:number, tokenLifetime?:number}} [options]
 * @returns {import('http').Server & {demo: object, state: object}}
 */
function createMockMeshServer(options) {
  const opts = options || {};
  const demo = createDemo(opts.seed, opts.classSize);
  if (opts.tokenLifetime) demo.tokenLifetime = opts.tokenLifetime;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const auth = req.headers['authorization'] || req.headers['auth-token'] || '';
    const token = String(auth).replace(/^Bearer\s+/i, '').trim();

    // ---- обновление токена: только с валидным текущим токеном ----
    if (path === '/v2/token/refresh') {
      if (!token || !demo.issuedTokens.has(token)) {
        return json(res, 401, { message: 'Unauthorized', error: 'token required' });
      }
      const next = 'mock-token-' + (++demo.tokenCounter + 1);
      demo.issuedTokens.add(next);
      demo.tokenUses[next] = 0;
      return json(res, 200, {
        token: next,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        role_id: '1',
        subsystem: 'familyweb'
      });
    }

    // ---- авторизация остальных методов ----
    if (!token || !demo.issuedTokens.has(token)) {
      return json(res, 401, { message: 'Unauthorized' });
    }
    demo.tokenUses[token] = (demo.tokenUses[token] || 0) + 1;
    if (demo.tokenUses[token] > demo.tokenLifetime) {
      // имитируем «протухший» токен: клиент должен вызвать refresh и повторить запрос
      return json(res, 401, { message: 'Token expired' });
    }

    const q = url.searchParams;

    if (path === '/api/family/web/v1/profile') {
      return json(res, 200, {
        hash: 'demo-hash',
        profile: {
          id: 900001,
          last_name: 'Демидова',
          first_name: 'Ольга',
          middle_name: 'Сергеевна',
          email: 'parent@example.ru',
          phone: '+7 (999) 000-00-00'
        },
        children: [
          {
            id: 17234613,
            contingent_guid: UUID_ME,
            last_name: demo.me.lastName,
            first_name: demo.me.firstName,
            middle_name: demo.me.middleName,
            class_name: '7 «Б»',
            school_name: 'ГБОУ Школа № 1234',
            school_id: 1234
          },
          {
            id: 17234614,
            contingent_guid: UUID_SIBLING,
            last_name: demo.students[0].lastName,
            first_name: demo.students[0].firstName,
            middle_name: demo.students[0].middleName,
            class_name: '3 «А»',
            school_name: 'ГБОУ Школа № 1234',
            school_id: 1234
          }
        ]
      });
    }

    if (path === '/api/gamification/v1/profiles') {
      const id = q.get('personId');
      const student = demo.students.find((s) => s.personId === id);
      if (!student) return json(res, 404, { message: 'person not found' });
      return json(res, 200, {
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName
      });
    }

    if (path === '/api/ej/rating/v1/rank/subjects') {
      const personId = q.get('personId') || UUID_ME;
      const date = q.get('date') || iso(new Date());
      const averages = averagesFor(demo, personId, null, null, date);
      const payload = SUBJECTS.map((subject) => {
        const all = demo.students.map((s) => averagesFor(demo, s.personId, subject.id, null, date)[subject.id]).filter((v) => v !== null);
        const mine = averages[subject.id];
        const better = all.filter((v) => v > (mine || 0)).length;
        return {
          subjectId: subject.id,
          subjectName: subject.name,
          rank: {
            averageMarkFive: mine,
            rankPlace: mine === null ? null : better + 1,
            rankStatus: mine === null ? 'NO_DATA' : better / all.length < 0.3 ? 'TOP' : 'MIDDLE',
            trend: (demo.random() > 0.6 ? '+' : demo.random() > 0.5 ? '-' : '') + (Math.round(demo.random() * 20) / 100).toFixed(2)
          },
          isExam: subject.id === 1 || subject.id === 3
        };
      });
      return json(res, 200, { payload });
    }

    if (path === '/api/ej/rating/v1/rank/class') {
      const subjectId = q.get('subjectId') ? Number(q.get('subjectId')) : null;
      const date = q.get('date') || iso(new Date());
      const previousTo = iso(new Date(parseIso(date).getTime() - 30 * 86400000));
      const payload = demo.students.map((student) => {
        const averages = averagesFor(demo, student.personId, subjectId, null, date);
        const previous = averagesFor(demo, student.personId, subjectId, null, previousTo);
        const mine = subjectId ? averages[subjectId] : averageOf(Object.values(averages).filter((v) => v !== null));
        const before = subjectId ? previous[subjectId] : averageOf(Object.values(previous).filter((v) => v !== null));
        return { personId: student.personId, average: mine, previous: before, imageId: 0 };
      });
      // места: 1 — лучший
      const sorted = payload.slice().sort((a, b) => (b.average || 0) - (a.average || 0));
      const placeOf = (value) => (value === null ? null : sorted.filter((s) => (s.average || 0) > value).length + 1);
      const previousSorted = payload.slice().sort((a, b) => (b.previous || 0) - (a.previous || 0));
      const previousPlaceOf = (value) => (value === null ? null : previousSorted.filter((s) => (s.previous || 0) > value).length + 1);

      return json(res, 200, {
        payload: payload.map((row) => ({
          personId: row.personId,
          imageId: 0,
          rank: {
            averageMarkFive: row.average,
            rankPlace: placeOf(row.average),
            rankStatus: placeOf(row.average) <= 5 ? 'TOP' : 'MIDDLE',
            trend: ((row.average || 0) - (row.previous || 0)).toFixed(2)
          },
          previousRank: {
            averageMarkFive: row.previous,
            rankPlace: previousPlaceOf(row.previous)
          }
        }))
      });
    }

    if (path === '/api/family/web/v1/marks') {
      const studentId = q.get('student_id') || UUID_ME;
      const from = q.get('from') || '2000-01-01';
      const to = q.get('to') || iso(new Date());
      const personId = personIdForStudentId(demo, studentId);
      const payload = [];
      SUBJECTS.forEach((subject) => {
        (demo.marks[personId][subject.id] || []).forEach((mark, index) => {
          if (mark.date < from || mark.date > to) return;
          payload.push({
            id: `${subject.id}${index}${personId.slice(-3)}`,
            value: mark.value,
            subject_id: subject.id,
            subject_name: subject.name,
            control_form_name: mark.form,
            weight: mark.weight,
            created_at: mark.date,
            is_exam: subject.id % 7 === 0,
            comment: mark.comment
          });
        });
      });
      payload.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return json(res, 200, { payload });
    }

    if (path === '/api/family/web/v1/subject_marks') {
      const studentId = q.get('student_id') || UUID_ME;
      const personId = personIdForStudentId(demo, studentId);
      return json(res, 200, {
        payload: SUBJECTS.map((subject) => {
          const marks = demo.marks[personId][subject.id] || [];
          return {
            subject_id: subject.id,
            subject_name: subject.name,
            marks: marks.map((m) => m.value),
            average: averageOf(marks.map((m) => m.value)),
            final_mark: marks.length ? Math.round(averageOf(marks.map((m) => m.value))) : null
          };
        })
      });
    }

    if (path === '/api/family/web/v1/homeworks') {
      const from = q.get('from') || iso(new Date(Date.now() - 7 * 86400000));
      const to = q.get('to') || iso(new Date());
      const payload = [];
      const start = parseIso(from);
      const end = parseIso(to);
      const random = makeRandom(4242);
      for (let time = start.getTime(); time <= end.getTime(); time += 86400000) {
        const day = new Date(time);
        const weekday = day.getDay();
        if (weekday === 0 || weekday === 6) continue;
        const count = 3 + Math.floor(random() * 3);
        for (let i = 0; i < count; i++) {
          const subject = SUBJECTS[Math.floor(random() * SUBJECTS.length)];
          const template = HOMEWORK_TEMPLATES[Math.floor(random() * HOMEWORK_TEMPLATES.length)];
          const page = 10 + Math.floor(random() * 150);
          payload.push({
            homework_entry_student_id: `${iso(day)}-${subject.id}-${i}`,
            subject_id: subject.id,
            subject_name: subject.name,
            date_assigned_on: iso(day),
            date_prepared: iso(new Date(time + 86400000 * (1 + Math.floor(random() * 3)))),
            description: template.replace('{p2}', String(page + 8)).replace('{p}', String(page)),
            is_done: random() > 0.55,
            attachments: random() > 0.9 ? [{ name: 'task.pdf' }] : []
          });
        }
      }
      return json(res, 200, { payload });
    }

    if (path === '/api/family/web/v1/schedule') {
      const date = q.get('date') || iso(new Date());
      const random = makeRandom(Number(date.replace(/-/g, '')) % 100000);
      const pool = SUBJECTS.slice().sort(() => random() - 0.5).slice(0, 7);
      const payload = pool.map((subject, index) => ({
        date,
        lesson_number: index + 1,
        begin_time: ['08:30', '09:25', '10:30', '11:25', '12:30', '13:25', '14:30'][index],
        end_time: ['09:15', '10:10', '11:15', '12:10', '13:15', '14:10', '15:15'][index],
        subject_name: subject.name,
        teacher_name: TEACHERS[Math.floor(random() * TEACHERS.length)],
        room_name: ROOMS[Math.floor(random() * ROOMS.length)],
        homework: random() > 0.5 ? 'см. домашнее задание в журнале' : '',
        mark: random() > 0.8 ? 5 : null,
        is_cancel: random() > 0.96
      }));
      return json(res, 200, { payload });
    }

    return json(res, 404, { message: 'mock: unknown path ' + path });
  });

  server.demo = demo;
  return server;
}

/** Поднимает мок-сервер на свободном порту и возвращает {server, port}. */
function startMockMeshServer(options) {
  const server = createMockMeshServer(options);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, demo: server.demo });
    });
  });
}

module.exports = {
  createMockMeshServer,
  startMockMeshServer,
  createDemo,
  SUBJECTS,
  UUID_ME,
  UUID_SIBLING,
  makeRandom,
  iso
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8790;
  const server = createMockMeshServer({});
  server.listen(port, '0.0.0.0', () => {
    console.log(`Мок-сервер МЭШ запущен: http://0.0.0.0:${port}`);
    console.log('Демо-токен для входа: mock-token-1');
  });
}
