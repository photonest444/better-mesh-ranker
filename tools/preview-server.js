#!/usr/bin/env node
/*!
 * Mesh Ranker — preview/web-сервер.
 *
 * Отдаёт тот же интерфейс, что и Electron/Android-версия (shared/ui), и
 * предоставляет REST-обёртку над ядром МЭШ. Полезен в трёх случаях:
 *   1) посмотреть интерфейс в браузере без установки зависимостей;
 *   2) демо-режим без аккаунта МЭШ (--demo, данные из мок-сервера);
 *   3) «веб-версия» приложения на своём компьютере в локальной сети.
 *
 * Запуск:
 *   node tools/preview-server.js --demo            # демо-данные
 *   node tools/preview-server.js --port 8080       # боевой режим, вход по токену МЭШ
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(ROOT, 'shared', 'ui');
const CORE_DIR = path.join(ROOT, 'shared', 'core');
const STATE_DIR = path.join(ROOT, '.preview');
const SESSION_FILE = path.join(STATE_DIR, 'session.json');

const MeshCore = require(path.join(CORE_DIR, 'mesh-core.js'));
const util = require(path.join(CORE_DIR, 'lib', 'util.js'));
const { startMockMeshServer } = require(path.join(__dirname, 'mock-mesh-server.js'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function ok(res, data) { sendJson(res, 200, { ok: true, data: data }); }
function fail(res, error, extra) {
  const code = error && error.code ? error.code : 'error';
  const status = error && error.status ? error.status : (code === 'bad-token' ? 400 : 502);
  sendJson(res, status, {
    ok: false,
    error: {
      code: code,
      message: MeshCore.describeError(error),
      raw: error && error.message ? String(error.message) : String(error)
    },
    extra: extra || null
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > (limit || 1024 * 512)) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { resolve({ raw: text }); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- сессия ----

function createSessionStore(file) {
  return {
    state: null,
    load() {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.token) this.state = parsed;
      } catch (e) { /* файла нет — это нормально */ }
      return this.state;
    },
    save(state) {
      this.state = state;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      } catch (e) {
        console.warn('Не удалось сохранить сессию:', e.message);
      }
      return state;
    },
    clear() {
      this.state = null;
      try { fs.unlinkSync(file); } catch (e) { /* уже удалено */ }
    }
  };
}

// ------------------------------------------------------------------ statics --

function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';

  let filePath;
  if (relative.startsWith('/core/')) {
    filePath = path.join(CORE_DIR, relative.slice('/core/'.length));
  } else {
    filePath = path.join(UI_DIR, relative.replace(/^\/+/, ''));
  }
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(UI_DIR)) && !resolved.startsWith(path.resolve(CORE_DIR))) {
    return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'Выход за пределы каталога' } });
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      if (!path.extname(resolved)) return serveStatic(req, res, new URL('/index.html', url));
      return sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'Файл не найден: ' + relative } });
    }
    const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// -------------------------------------------------------------------- API ----

/**
 * Создаёт сервер приложения.
 * @param {{demo?:boolean, port?:number, host?:string, mockPort?:number, quiet?:boolean}} options
 */
function createPreviewServer(options) {
  const opts = options || {};
  const store = createSessionStore(SESSION_FILE);
  const context = {
    demo: !!opts.demo,
    mockPort: opts.mockPort || null,
    mockServer: null,
    client: null,
    profile: null,
    children: [],
    activeStudentId: null
  };

  function baseUrl() {
    return context.demo && context.mockPort ? `http://127.0.0.1:${context.mockPort}` : MeshCore.HOST;
  }

  function createClient(token, profileId) {
    return new MeshCore.MeshClient({
      token: token,
      profileId: profileId,
      baseUrl: baseUrl(),
      timeout: 20000,
      onToken: (newToken, meta) => {
        // Автосохранение: токен обновился — сразу фиксируем на диске
        const state = Object.assign({}, store.state || {}, {
          token: newToken,
          profileId: context.client ? context.client.profileId : (store.state && store.state.profileId) || null,
          savedAt: Date.now(),
          refreshed: meta && meta.reason
        });
        store.save(state);
        context.lastRefresh = Date.now();
      }
    });
  }

  function statePayload() {
    const token = store.state && store.state.token ? store.state.token : null;
    return {
      demo: context.demo,
      authRequired: true,
      authenticated: !!token,
      token: MeshCore.describeToken(token),
      loginUrl: MeshCore.loginUrl(),
      profile: context.profile,
      children: context.children,
      activeStudentId: context.activeStudentId,
      lastRefresh: context.lastRefresh || null,
      host: context.demo ? 'демо-режим (локальные данные)' : MeshCore.HOST
    };
  }

  async function restoreSession() {
    const state = store.load();
    if (!state || !state.token) return;
    const client = createClient(state.token, state.profileId);
    context.client = client;
    try {
      const profile = await client.fetchProfile();
      context.profile = profile;
      context.children = profile.children;
      context.activeStudentId = state.activeStudentId || (profile.defaultChild && profile.defaultChild.id) || null;
      if (profile.defaultChild && !client.profileId) client.setProfileId(profile.defaultChild.id);
    } catch (error) {
      context.restoreError = MeshCore.describeError(error);
      store.clear();
      context.client = null;
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, url);

      // ---- health ----
      if (pathname === '/api/health') {
        return ok(res, { server: 'mesh-ranker-preview', demo: context.demo, time: Date.now() });
      }

      // ---- состояние сессии ----
      if (pathname === '/api/state' && req.method === 'GET') {
        return ok(res, statePayload());
      }

      // ---- демо-токен (только в демо-режиме) ----
      if (pathname === '/api/demo/token' && req.method === 'POST') {
        if (!context.demo) return fail(res, { code: 'demo-disabled', message: 'Демо-режим выключен' }, null);
        return ok(res, { token: 'mock-token-1', hint: 'Демо-токен мок-сервера' });
      }

      // ---- вход по токену МЭШ ----
      if (pathname === '/api/sign-in' && req.method === 'POST') {
        const body = await readBody(req);
        const token = MeshCore.extractToken(body.token || body.raw || '') || util.asStr(body.token).trim();
        if (!token) return fail(res, { code: 'bad-token', message: 'Токен не распознан — вставьте значение целиком' });
        const client = createClient(token, null);
        const result = await client.signIn(token);
        context.client = client;
        context.profile = result.profile;
        context.children = result.profile.children;
        context.activeStudentId = result.child ? result.child.id : null;
        context.lastRefresh = null;
        store.save({
          token: result.token,
          profileId: result.profileId,
          activeStudentId: context.activeStudentId,
          demo: context.demo,
          savedAt: Date.now()
        });
        return ok(res, statePayload());
      }

      if (pathname === '/api/sign-out' && req.method === 'POST') {
        store.clear();
        context.client = null;
        context.profile = null;
        context.children = [];
        context.activeStudentId = null;
        return ok(res, statePayload());
      }

      // ---- обновление токена вручную ----
      if (pathname === '/api/refresh-token' && req.method === 'POST') {
        if (!context.client) return fail(res, { code: 'unauthorized', message: 'Нет активной сессии' });
        const token = await context.client.refreshToken();
        if (!token) return fail(res, { code: 'refresh-failed', status: 502, message: 'МЭШ не выдал новый токен — войдите заново' });
        return ok(res, statePayload());
      }

      // ---- выбор активного ученика ----
      if (pathname === '/api/student' && req.method === 'POST') {
        const body = await readBody(req);
        const child = context.children.find((c) => String(c.id) === String(body.studentId));
        if (!child) return fail(res, { code: 'not-found', message: 'Ученик не найден в профиле' });
        context.activeStudentId = child.id;
        if (context.client) context.client.setProfileId(child.id);
        store.save(Object.assign({}, store.state || {}, { activeStudentId: child.id }));
        return ok(res, statePayload());
      }

      // ---- дальше — методы, требующие авторизации ----
      if (!context.client || !context.client.token) {
        return fail(res, { code: 'unauthorized', status: 401, message: 'Требуется вход в МЭШ' });
      }

      const client = context.client;
      const q = url.searchParams;
      const studentId = q.get('studentId') || context.activeStudentId;
      // personId — это contingent_guid (UUID) ученика, а studentId — числовой id;
      // интерфейс передаёт studentId, поэтому подставляем соответствующего ребёнка.
      const activeChild = context.children.find((child) => String(child.id) === String(studentId)) || context.children[0] || null;
      const personId = q.get('personId') || (activeChild ? activeChild.personId : studentId);

      if (pathname === '/api/profile') {
        return ok(res, await client.fetchProfile());
      }

      if (pathname === '/api/subjects') {
        const date = q.get('date') || util.todayIso();
        const subjects = await client.getSubjects(personId, date);
        return ok(res, { date: date, personId: personId, subjects: subjects });
      }

      if (pathname === '/api/subject-marks') {
        return ok(res, { marks: await client.getSubjectMarks(studentId) });
      }

      if (pathname === '/api/rank') {
        const board = await client.getRankBoard({
          personId: personId,
          date: q.get('date') || util.todayIso(),
          subjectId: q.get('subjectId') || null,
          subjectName: q.get('subjectName') || null
        });
        return ok(res, board);
      }

      if (pathname === '/api/marks') {
        const to = q.get('to') || util.todayIso();
        const from = q.get('from') || util.addDays(to, -30);
        const marks = await client.getMarks(studentId, from, to);
        return ok(res, { from: from, to: to, marks: marks, summary: MeshCore.summarizeMarks(marks) });
      }

      if (pathname === '/api/homeworks') {
        const to = q.get('to') || util.todayIso();
        const from = q.get('from') || util.addDays(to, -7);
        const homeworks = await client.getHomeworks(studentId, from, to);
        return ok(res, { from: from, to: to, homeworks: homeworks });
      }

      if (pathname === '/api/schedule') {
        const date = q.get('date') || util.todayIso();
        const lessons = await client.getSchedule(studentId, date);
        return ok(res, { date: date, lessons: lessons });
      }

      if (pathname === '/api/names') {
        const ids = util.asStr(q.get('personIds')).split(',').map((s) => s.trim()).filter(Boolean);
        return ok(res, { names: await client.getNames(ids) });
      }

      return fail(res, { code: 'not-found', status: 404, message: 'Неизвестный метод: ' + pathname });
    } catch (error) {
      return fail(res, error);
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => fail(res, error));
  });

  server.context = context;
  server.stateStore = store;
  server.restoreSession = restoreSession;
  return server;
}

// ---------------------------------------------------------------- запуск ----

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf('--' + name);
    return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
  };
  const demo = args.includes('--demo') || process.env.MESH_DEMO === '1';
  const port = Number(flag('port', process.env.PORT || 8787));
  const host = flag('host', '127.0.0.1');

  let mock = null;
  if (demo) {
    mock = await startMockMeshServer({});
    console.log(`Мок-сервер МЭШ: http://127.0.0.1:${mock.port} (демо-данные)`);
  }

  const server = createPreviewServer({ demo: demo, mockPort: mock ? mock.port : null });
  if (demo && mock) {
    // В демо-режиме сразу подставляем демо-токен, чтобы интерфейс был рабочим
    server.context.demoToken = 'mock-token-1';
  }
  await server.restoreSession();
  server.listen(port, host, () => {
    console.log(`Mesh Ranker: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(demo ? 'Режим: ДЕМО (данные генерируются локально)' : 'Режим: боевой (нужен токен МЭШ)');
  });
}

module.exports = { createPreviewServer, SESSION_FILE };

if (require.main === module) {
  main().catch((error) => {
    console.error('Не удалось запустить сервер:', error);
    process.exit(1);
  });
}
