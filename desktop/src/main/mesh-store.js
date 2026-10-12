'use strict';
/*!
 * Mesh Ranker — хранилище сессии для desktop-версии.
 *
 * Токен МЭШ шифруется средствами ОС через Electron safeStorage
 * (Windows — DPAPI, macOS — Keychain, Linux — libsecret/gnome-keyring),
 * а если шифрование недоступно, сохраняется как обычный JSON с предупреждением
 * в лог и правами 0600.
 *
 * Дополнительно поддерживается импорт кэша имён от CLI-версии
 * (~/.better-mesh-ranker/users_cache.json), чтобы рейтинг открывался мгновенно.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fallback === undefined ? null : fallback;
  }
}

function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: mode || 0o600 });
  try { fs.chmodSync(file, mode || 0o600); } catch (error) { /* windows */ }
}

class SessionStore {
  /**
   * @param {object} options
   *   dir        — каталог данных приложения (app.getPath('userData'))
   *   safeStorage — модуль electron.safeStorage (может быть undefined)
   */
  constructor(options) {
    const opts = options || {};
    this.dir = opts.dir;
    this.safeStorage = opts.safeStorage || null;
    this.sessionFile = path.join(this.dir, 'session.json');
    this.cacheFile = path.join(this.dir, 'users_cache.json');
    this.settingsFile = path.join(this.dir, 'settings.json');
    this.session = null;
    this.nameCache = {};
    this.settings = {};
  }

  /** Доступно ли шифрование средствами ОС. */
  canEncrypt() {
    try {
      return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch (error) {
      return false;
    }
  }

  encrypt(text) {
    if (!this.canEncrypt()) return { plain: text };
    try {
      return { encrypted: this.safeStorage.encryptString(text).toString('base64') };
    } catch (error) {
      return { plain: text };
    }
  }

  decrypt(blob) {
    if (!blob) return null;
    try {
      if (blob.encrypted) return this.safeStorage.decryptString(Buffer.from(blob.encrypted, 'base64'));
      return blob.plain || null;
    } catch (error) {
      return null;
    }
  }

  // ------------------------------------------------------------- сессия ----

  load() {
    const raw = readJson(this.sessionFile, null);
    if (!raw) return null;
    const token = this.decrypt(raw.token);
    if (!token) return null;
    this.session = {
      token: token,
      tokenProfileId: raw.tokenProfileId || null,
      studentId: raw.studentId || null,
      profileId: raw.profileId || null,
      parentName: raw.parentName || null,
      savedAt: raw.savedAt || null,
      encrypted: !!raw.token.encrypted
    };
    return this.session;
  }

  save(patch) {
    const current = this.session || {};
    const next = Object.assign({}, current, patch || {});
    this.session = next;
    writeJson(this.sessionFile, {
      token: this.encrypt(next.token || ''),
      tokenProfileId: next.tokenProfileId || null,
      studentId: next.studentId || null,
      profileId: next.profileId || null,
      parentName: next.parentName || null,
      savedAt: Date.now()
    });
    return next;
  }

  clear() {
    this.session = null;
    try { fs.unlinkSync(this.sessionFile); } catch (error) { /* уже нет */ }
  }

  /** Токен МЭШ в открытом виде — только внутри главного процесса. */
  getToken() {
    if (!this.session) this.load();
    return this.session ? this.session.token : null;
  }

  // --------------------------------------------------------- кэш имён -----

  loadNameCache() {
    this.nameCache = readJson(this.cacheFile, {}) || {};
    return this.nameCache;
  }

  saveNameCache(cache) {
    this.nameCache = cache || {};
    try { writeJson(this.cacheFile, this.nameCache); } catch (error) { /* некритично */ }
  }

  /** Подтягивает кэш имён CLI-версии, если он есть. */
  importCliCache() {
    const cliFile = path.join(os.homedir(), '.better-mesh-ranker', 'users_cache.json');
    const legacy = readJson(cliFile, null);
    if (!legacy) return 0;
    const merged = Object.assign({}, legacy, this.loadNameCache());
    this.saveNameCache(merged);
    return Object.keys(legacy).length;
  }

  // ---------------------------------------------------------- настройки ---

  loadSettings(defaults) {
    this.settings = Object.assign({}, defaults || {}, readJson(this.settingsFile, {}) || {});
    return this.settings;
  }

  saveSettings(patch) {
    this.settings = Object.assign({}, this.settings, patch || {});
    try { writeJson(this.settingsFile, this.settings, 0o644); } catch (error) { /* некритично */ }
    return this.settings;
  }
}

module.exports = { SessionStore, readJson, writeJson };
