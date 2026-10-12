/*!
 * Mesh Ranker — слой платформы.
 *
 * Один и тот же интерфейс в трёх средах:
 *   • Electron (Windows/Linux): window.meshDesktop — мост к главному процессу (IPC);
 *   • Android: window.MeshNative — мост к Kotlin через @JavascriptInterface;
 *   • Web/preview: REST-вызовы /api/* к локальному серверу (tools/preview-server.js).
 *
 * Любой вызов возвращает Promise с данными либо отклоняется ошибкой
 * с полями code/message (её показывает интерфейс).
 */
(function (root) {
  'use strict';

  var util = root.MeshLib.util;
  var MeshCore = root.MeshCore;

  var SETTINGS_KEY = 'mesh.settings.v1';
  var DEFAULT_SETTINGS = {
    theme: 'auto',            // auto | dark | light
    pageSize: 25,
    defaultView: 'ranking',
    denseTables: false,
    autoRefreshToken: true,
    showHistogram: true,
    onlyMyClass: true
  };

  var listeners = {};
  var pending = Object.create(null);
  var callCounter = 0;

  function mode() {
    if (typeof window !== 'undefined' && window.meshDesktop) return 'electron';
    if (typeof window !== 'undefined' && window.MeshNative) return 'android';
    return 'web';
  }

  function emit(channel, payload) {
    (listeners[channel] || []).forEach(function (handler) {
      try { handler(payload); } catch (error) { console.error('Ошибка в обработчике ' + channel, error); }
    });
  }

  function on(channel, handler) {
    if (!listeners[channel]) listeners[channel] = [];
    listeners[channel].push(handler);
    return function off() {
      listeners[channel] = listeners[channel].filter(function (h) { return h !== handler; });
    };
  }

  /** Ответ моста: {ok:true,data} | {ok:false,error:{code,message}}. */
  function unwrap(response) {
    if (!response) throw platformError('empty-response', 'Пустой ответ платформы');
    if (response.ok) return response.data;
    var error = response.error || {};
    throw platformError(error.code || 'error', error.message || 'Неизвестная ошибка', error.raw);
  }

  function platformError(code, message, raw) {
    var error = new Error(message);
    error.code = code;
    error.raw = raw || null;
    return error;
  }

  // ------------------------------------------------------------ нативные мосты --

  function callNative(method, payload) {
    return new Promise(function (resolve, reject) {
      var bridge = window.meshDesktop || window.MeshNative;
      if (!bridge) return reject(platformError('no-bridge', 'Мост платформы недоступен'));
      try {
        if (bridge.invoke.length >= 2 || window.meshDesktop) {
          // Electron: invoke(method, payload) → Promise
          Promise.resolve(bridge.invoke(method, payload || {})).then(unwrap).then(resolve, reject);
          return;
        }
        // Android: invoke(id, method, payloadJson) + window.__meshResolve(id, json)
        var id = 'r' + (++callCounter);
        pending[id] = { resolve: resolve, reject: reject };
        bridge.invoke(id, method, JSON.stringify(payload || {}));
        setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(platformError('timeout', 'Мост Android не ответил вовремя'));
        }, 60000);
      } catch (error) {
        reject(platformError('bridge-error', String(error && error.message ? error.message : error)));
      }
    });
  }

  // --------------------------------------------------------------- web (REST) --

  var REST = {
    state: { method: 'GET', path: '/api/state' },
    signIn: { method: 'POST', path: '/api/sign-in' },
    signOut: { method: 'POST', path: '/api/sign-out' },
    refreshToken: { method: 'POST', path: '/api/refresh-token' },
    selectStudent: { method: 'POST', path: '/api/student' },
    profile: { method: 'GET', path: '/api/profile' },
    subjects: { method: 'GET', path: '/api/subjects' },
    subjectMarks: { method: 'GET', path: '/api/subject-marks' },
    rank: { method: 'GET', path: '/api/rank' },
    marks: { method: 'GET', path: '/api/marks' },
    homeworks: { method: 'GET', path: '/api/homeworks' },
    schedule: { method: 'GET', path: '/api/schedule' },
    names: { method: 'GET', path: '/api/names' },
    demoToken: { method: 'POST', path: '/api/demo/token' }
  };

  function callWeb(method, payload) {
    var route = REST[method];
    if (!route) return Promise.reject(platformError('not-supported', 'Метод недоступен в web-режиме: ' + method));
    var query = '';
    var body = null;
    if (route.method === 'GET') {
      var parts = [];
      Object.keys(payload || {}).forEach(function (key) {
        var value = payload[key];
        if (value === undefined || value === null || value === '') return;
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      });
      query = parts.length ? '?' + parts.join('&') : '';
    } else {
      body = JSON.stringify(payload || {});
    }
    return fetch(route.path + query, {
      method: route.method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body
    }).catch(function (error) {
      throw platformError('network', 'Нет связи с сервером приложения: ' + error.message);
    }).then(function (response) {
      return response.json().catch(function () {
        throw platformError('invalid-response', 'Сервер вернул не-JSON ответ');
      });
    }).then(unwrap);
  }

  function call(method, payload) {
    if (mode() === 'web') return callWeb(method, payload);
    return callNative(method, payload);
  }

  // ------------------------------------------------------------- настройки ----

  var settingsCache = null;

  function loadSettings() {
    if (settingsCache) return settingsCache;
    var stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    } catch (error) { stored = null; }
    settingsCache = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    return settingsCache;
  }

  function saveSettings(patch) {
    settingsCache = Object.assign(loadSettings(), patch || {});
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache)); } catch (error) { /* приватный режим */ }
    emit('settings', settingsCache);
    return settingsCache;
  }

  /** Тема: auto — по системной настройке. */
  function applyTheme(theme) {
    var value = theme || loadSettings().theme;
    var dark = value === 'dark' || (value === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    return dark ? 'dark' : 'light';
  }

  // ------------------------------------------------------------------ файлы ---

  function saveFile(fileName, text, mime) {
    if (mode() === 'web') {
      root.MeshLib.format.downloadText(fileName, text, mime);
      return Promise.resolve(true);
    }
    return call('saveFile', { fileName: fileName, text: text, mime: mime })
      .then(function (result) { return !!(result && result.saved !== false); })
      .catch(function () {
        root.MeshLib.format.downloadText(fileName, text, mime);
        return true;
      });
  }

  // ---------------------------------------------------------------- события ---

  if (typeof window !== 'undefined') {
    // Electron: главный процесс присылает события (обновление токена, статус)
    if (window.meshDesktop && window.meshDesktop.on) {
      window.meshDesktop.on('state', function (payload) { emit('state', payload); });
      window.meshDesktop.on('token', function (payload) { emit('token', payload); });
      window.meshDesktop.on('status', function (payload) { emit('status', payload); });
    }
    // Android и Electron: ответы мостов приходят в эти глобальные функции
    window.__meshResolve = function (id, json) {
      var entry = pending[id];
      if (!entry) return;
      delete pending[id];
      var parsed;
      try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json;
      } catch (error) {
        return entry.reject(platformError('invalid-response', 'Не удалось разобрать ответ моста'));
      }
      try { entry.resolve(unwrap(parsed)); } catch (error) { entry.reject(error); }
    };
    window.__meshEvent = function (channel, json) {
      var payload = json;
      try { payload = typeof json === 'string' ? JSON.parse(json) : json; } catch (error) { /* оставляем строку */ }
      emit(channel, payload);
    };
    window.__meshLog = function (message) { console.log('[platform]', message); };
  }

  // ------------------------------------------------------------------- API ----

  var MeshPlatform = {
    mode: mode(),
    isNative: mode() !== 'web',
    loginUrl: function () { return MeshCore.loginUrl(); },

    /** Начальное состояние: авторизован ли пользователь, профиль, дети. */
    state: function () { return call('state', {}); },

    /** Вход по токену (токен можно вставить или получить из окна входа). */
    signIn: function (token) { return call('signIn', { token: token }); },

    signOut: function () { return call('signOut', {}); },

    /** Принудительное обновление токена МЭШ. */
    refreshToken: function () { return call('refreshToken', {}); },

    /** Переключение активного ученика (если в профиле несколько детей). */
    selectStudent: function (studentId) { return call('selectStudent', { studentId: studentId }); },

    /**
     * Открывает встроенное окно входа МЭШ (Electron) или WebView (Android),
     * перехватывает токен и возвращает его. В web-режиме вернёт null —
     * интерфейс покажет инструкцию и поле для вставки токена.
     */
    startMeshLogin: function () {
      if (mode() === 'web') return Promise.resolve(null);
      return call('startMeshLogin', { url: MeshCore.loginUrl() }).then(function (result) {
        return (result && result.token) || null;
      });
    },

    profile: function () { return call('profile', {}); },
    subjects: function (params) { return call('subjects', params || {}); },
    subjectMarks: function (params) { return call('subjectMarks', params || {}); },
    rank: function (params) { return call('rank', params || {}); },
    marks: function (params) { return call('marks', params || {}); },
    homeworks: function (params) { return call('homeworks', params || {}); },
    schedule: function (params) { return call('schedule', params || {}); },
    names: function (personIds) { return call('names', { personIds: (personIds || []).join(',') }); },
    demoToken: function () { return call('demoToken', {}); },

    saveFile: saveFile,
    settings: {
      get: loadSettings,
      set: saveSettings,
      reset: function () { settingsCache = null; return saveSettings({}); }
    },
    applyTheme: applyTheme,
    on: on,
    emit: emit
  };

  root.MeshPlatform = MeshPlatform;
})(typeof self !== 'undefined' ? self : this);
