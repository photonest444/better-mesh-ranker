'use strict';
/*!
 * Mesh Ranker — сервис МЭШ для главного процесса Electron.
 *
 * Здесь и только здесь живут сетевые запросы: renderer-процесс (интерфейс)
 * не имеет доступа к сети напрямую и общается через IPC. Используется то же
 * ядро, что и в web/Android-версиях (shared/core/mesh-core.js), поэтому
 * разбор ответов МЭШ и автообновление токена везде одинаковые.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SessionStore } = require('./mesh-store');

const DEFAULT_SETTINGS = {
  theme: 'auto',
  pageSize: 25,
  defaultView: 'ranking',
  denseTables: false,
  autoRefreshToken: true,
  autoRefreshMinutes: 0,
  showHistogram: true,
  onlyMyClass: true
};

/** Ищет модуль ядра: сначала рядом (упакованная сборка), потом в репозитории. */
function resolveCore(relative) {
  const candidates = [
    path.join(__dirname, '..', 'core', relative),
    path.join(__dirname, '..', '..', '..', 'shared', 'core', relative),
    path.join(__dirname, '..', '..', '..', 'tools', relative)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Не найден модуль ядра: ' + relative);
}

const MeshCore = resolveCore('mesh-core.js');

class MeshService extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.demo = !!opts.demo;
    this.store = opts.store || new SessionStore({ dir: opts.dir, safeStorage: opts.safeStorage });
    this.settings = this.store.loadSettings(DEFAULT_SETTINGS);
    this.client = null;
    this.profile = null;
    this.children = [];
    this.activeStudentId = null;
    this.demoServer = null;
    this.demoPort = null;
    this.lastRefreshAt = null;
    this.loggedInAt = null;
  }

  async init() {
    const imported = this.store.importCliCache();
    if (imported) console.log(`[mesh] импортировано имён из кэша CLI: ${imported}`);
    this.store.loadNameCache();

    if (this.demo) await this.startDemoServer();

    const session = this.store.load();
    if (!session || !session.token) return this;

    this.client = this.createClient(session.token, session.profileId);
    try {
      const profile = await this.client.fetchProfile();
      this.profile = profile;
      this.children = profile.children;
      this.activeStudentId = session.studentId || (profile.defaultChild && profile.defaultChild.id) || null;
    } catch (error) {
      console.warn('[mesh] сохранённый токен не сработал:', error.message);
      this.client = null;
      this.store.clear();
    }
    return this;
  }

  /** Запускает встроенный мок-сервер МЭШ (демо-режим без аккаунта). */
  startDemoServer() {
    return new Promise((resolve) => {
      const mock = resolveCore('mock-mesh-server.js');
      const server = mock.createMockMeshServer({});
      server.listen(0, '127.0.0.1', () => {
        this.demoServer = server;
        this.demoPort = server.address().port;
        console.log(`[mesh] демо-сервер МЭШ: http://127.0.0.1:${this.demoPort}`);
        resolve(this.demoPort);
      });
    });
  }

  baseUrl() {
    if (this.demo && this.demoPort) return `http://127.0.0.1:${this.demoPort}`;
    return MeshCore.HOST;
  }

  createClient(token, profileId) {
    const self = this;
    return new MeshCore.MeshClient({
      token: token,
      profileId: profileId,
      baseUrl: this.baseUrl(),
      timeout: 20000,
      nameCache: this.store.nameCache,
      autoRefresh: this.settings.autoRefreshToken !== false,
      onToken: (newToken, meta) => {
        // Автосохранение обновлённого токена: пользователю не нужно входить снова
        self.store.save({ token: newToken, profileId: self.client ? self.client.profileId : profileId });
        self.lastRefreshAt = Date.now();
        self.emit('token', {
          token: newToken,
          mask: MeshCore.maskToken(newToken),
          reason: meta && meta.reason,
          savedAt: self.lastRefreshAt
        });
      }
    });
  }

  ensureClient(token, profileId) {
    if (!this.client) this.client = this.createClient(token, profileId);
    if (token) this.client.setToken(token);
    if (profileId !== undefined) this.client.setProfileId(profileId);
    return this.client;
  }

  student() {
    const id = this.activeStudentId;
    if (!id) return this.children[0] || null;
    return this.children.find((child) => String(child.id) === String(id)) || this.children[0] || null;
  }

  tokenInfo() {
    const token = this.store.getToken();
    const info = MeshCore.describeToken(token);
    if (!info.present) return info;
    return Object.assign({}, info, { maskedOnly: true });
  }

  state() {
    return {
      demo: this.demo,
      platform: process.platform,
      authenticated: !!(this.client && this.store.getToken()),
      token: this.tokenInfo(),
      loginUrl: MeshCore.loginUrl(),
      profile: this.profile,
      children: this.children,
      activeStudentId: this.activeStudentId,
      lastRefresh: this.lastRefreshAt,
      loggedInAt: this.loggedInAt,
      storage: this.store.canEncrypt() ? 'safeStorage' : 'plain',
      host: this.demo ? 'демо-режим (встроенные данные)' : MeshCore.HOST,
      settings: this.settings
    };
  }

  // --------------------------------------------------------------- методы ---

  async signIn(token) {
    const candidate = MeshCore.extractToken(token) || String(token || '').trim();
    if (!candidate) throw Object.assign(new Error('Пустой токен'), { code: 'bad-token' });
    if (!MeshCore.looksLikeToken(candidate)) throw Object.assign(new Error('Значение не похоже на токен МЭШ'), { code: 'bad-token' });

    const client = this.createClient(candidate, null);
    const profile = await client.fetchProfile();
    const child = profile.defaultChild;
    this.client = client;
    this.profile = profile;
    this.children = profile.children;
    this.activeStudentId = child ? child.id : null;
    this.loggedInAt = Date.now();
    this.store.save({
      token: candidate,
      profileId: child ? child.id : null,
      studentId: this.activeStudentId,
      parentName: profile.parent ? profile.parent.name : null
    });
    this.emit('state', this.state());
    return this.state();
  }

  signOut() {
    this.store.clear();
    this.client = null;
    this.profile = null;
    this.children = [];
    this.activeStudentId = null;
    this.loggedInAt = null;
    this.emit('state', this.state());
    return this.state();
  }

  async refreshToken() {
    if (!this.client) throw Object.assign(new Error('Нет активной сессии'), { code: 'unauthorized', status: 401 });
    const token = await this.client.refreshToken();
    if (!token) throw Object.assign(new Error('МЭШ не выдал новый токен — войдите заново'), { code: 'refresh-failed' });
    return this.state();
  }

  async selectStudent(studentId) {
    const child = this.children.find((item) => String(item.id) === String(studentId));
    if (!child) throw Object.assign(new Error('Ученик не найден'), { code: 'not-found' });
    this.activeStudentId = child.id;
    if (this.client) this.client.setProfileId(child.id);
    this.store.save({ studentId: child.id });
    this.emit('state', this.state());
    return this.state();
  }

  requireClient() {
    if (!this.client) throw Object.assign(new Error('Требуется вход в МЭШ'), { code: 'unauthorized', status: 401 });
    return this.client;
  }

  async profile() {
    const profile = await this.requireClient().fetchProfile();
    this.profile = profile;
    this.children = profile.children;
    return profile;
  }

  async subjects(params) {
    const child = this.studentFrom(params);
    return {
      date: (params && params.date) || this.today(),
      personId: child.personId,
      subjects: await this.requireClient().getSubjects(child.personId, (params && params.date) || this.today())
    };
  }

  async subjectMarks(params) {
    const child = this.studentFrom(params);
    return { marks: await this.requireClient().getSubjectMarks(child.id) };
  }

  async rank(params) {
    const p = params || {};
    const child = this.studentFrom(p);
    const board = await this.requireClient().getRankBoard({
      personId: child.personId,
      date: p.date || this.today(),
      subjectId: p.subjectId || null,
      subjectName: p.subjectName || null,
      names: this.store.nameCache
    });
    this.store.saveNameCache(this.client.nameCache);
    return board;
  }

  async marks(params) {
    const p = params || {};
    const child = this.studentFrom(p);
    const to = p.to || this.today();
    const from = p.from || this.daysAgo(to, 30);
    const marks = await this.requireClient().getMarks(child.id, from, to);
    return { from, to, marks, summary: MeshCore.summarizeMarks(marks) };
  }

  async homeworks(params) {
    const p = params || {};
    const child = this.studentFrom(p);
    const to = p.to || this.today();
    const from = p.from || this.daysAgo(to, 7);
    return { from, to, homeworks: await this.requireClient().getHomeworks(child.id, from, to) };
  }

  async schedule(params) {
    const p = params || {};
    const child = this.studentFrom(p);
    const date = p.date || this.today();
    return { date, lessons: await this.requireClient().getSchedule(child.id, date) };
  }

  async names(personIds) {
    const ids = Array.isArray(personIds) ? personIds : String(personIds || '').split(',');
    const names = await this.requireClient().getNames(ids.map((id) => String(id).trim()).filter(Boolean));
    this.store.saveNameCache(this.client.nameCache);
    return { names };
  }

  demoToken() {
    if (!this.demo) throw Object.assign(new Error('Демо-режим выключен'), { code: 'demo-disabled' });
    return { token: 'mock-token-1', hint: 'Демо-токен встроенного сервера' };
  }

  studentFrom(params) {
    const p = params || {};
    if (p.studentId && this.children.length) {
      const found = this.children.find((child) => String(child.id) === String(p.studentId));
      if (found) return found;
    }
    const child = this.student();
    if (!child) throw Object.assign(new Error('Не выбран ученик'), { code: 'no-student' });
    return child;
  }

  today() {
    const now = new Date();
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  daysAgo(iso, days) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const date = new Date(y, m - 1, d - days);
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  clearCache() {
    this.store.saveNameCache({});
    if (this.client) this.client.nameCache = Object.create(null);
    return { cleared: true };
  }

  settingsGet() {
    return this.settings;
  }

  settingsSet(patch) {
    this.settings = this.store.saveSettings(patch || {});
    if (this.client) this.client.autoRefresh = this.settings.autoRefreshToken !== false;
    return this.settings;
  }

  /** Единая точка входа для IPC: возвращает данные либо бросает ошибку с кодом. */
  async handle(method, payload) {
    switch (method) {
      case 'state': return this.state();
      case 'signIn': return this.signIn(payload && payload.token);
      case 'signOut': return this.signOut();
      case 'refreshToken': return this.refreshToken();
      case 'selectStudent': return this.selectStudent(payload && payload.studentId);
      case 'profile': return this.profile();
      case 'subjects': return this.subjects(payload);
      case 'subjectMarks': return this.subjectMarks(payload);
      case 'rank': return this.rank(payload);
      case 'marks': return this.marks(payload);
      case 'homeworks': return this.homeworks(payload);
      case 'schedule': return this.schedule(payload);
      case 'names': return this.names(payload && payload.personIds);
      case 'demoToken': return this.demoToken();
      case 'clearCache': return this.clearCache();
      case 'settingsGet': return this.settingsGet();
      case 'settingsSet': return this.settingsSet(payload);
      case 'ping': return { ok: await this.requireClient().ping() };
      case 'loginUrl': return { url: MeshCore.loginUrl() };
      default:
        throw Object.assign(new Error('Неизвестный метод: ' + method), { code: 'not-found' });
    }
  }

  dispose() {
    if (this.demoServer) {
      try { this.demoServer.close(); } catch (error) { /* уже закрыт */ }
    }
  }
}

module.exports = { MeshService, DEFAULT_SETTINGS, MeshCore };
