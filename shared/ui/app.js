/*!
 * Mesh Ranker — оболочка приложения: навигация, состояние, события платформы.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var format = ui.format;
  var util = ui.util;
  var platform = root.MeshPlatform;

  var VERSION = { app: '1.0.0', core: '1.0.0' };

  var app = {
    state: null,
    viewId: null,
    views: {},
    instances: {},
    timer: null,
    date: util.todayIso(),

    // ------------------------------------------------------------- доступы ---
    currentState: function () { return app.state || {}; },

    student: function () {
      var state = app.currentState();
      var children = state.children || [];
      if (!children.length) return null;
      var active = children.filter(function (child) { return String(child.id) === String(state.activeStudentId); })[0];
      return active || children[0];
    },

    openRanking: function (subjectId) {
      app.go('ranking');
      var instance = app.instances.ranking;
      if (instance && instance.setDate) instance.setDate(app.date);
      ui.toast('Открыт рейтинг' + (subjectId ? ' по предмету' : ''), { type: 'info', timeout: 2000 });
      var ranking = app.instances.ranking;
      if (ranking && ranking.selectSubject) ranking.selectSubject(subjectId);
    },

    // -------------------------------------------------------------- каркас ---
    renderShell: function () {
      var navHost = ui.qs('#nav');
      ui.clear(navHost);
      Object.keys(ui.views).forEach(function (id, index) {
        var view = ui.views[id];
        navHost.appendChild(h('button', {
          class: 'nav-item' + (id === app.viewId ? ' nav-active' : ''),
          title: view.hint,
          onclick: function () { app.go(id); }
        }, [
          h('span', { class: 'nav-icon', text: ui.icon(view.icon) }),
          h('span', { class: 'nav-title', text: view.title }),
          h('span', { class: 'nav-key', text: String(index + 1) })
        ]));
      });
    },

    renderTopbar: function () {
      var state = app.currentState();
      var left = ui.qs('#topbar-left');
      var right = ui.qs('#topbar-right');
      ui.clear(left);
      ui.clear(right);

      var child = app.student();
      if (child) {
        var children = state.children || [];
        left.appendChild(h('div', { class: 'topbar-student' }, [
          h('span', { class: 'topbar-avatar', text: (child.firstName || child.name || '?').slice(0, 1) }),
          h('div', { class: 'topbar-student-body' }, [
            h('div', { class: 'topbar-student-name', text: child.name }),
            h('div', { class: 'muted small', text: [child.className, child.schoolName].filter(Boolean).join(' · ') || 'класс не указан' })
          ]),
          children.length > 1 ? ui.field({
            type: 'select',
            className: 'field-compact',
            value: String(state.activeStudentId || ''),
            options: children.map(function (item) { return { value: String(item.id), label: item.shortName || item.name }; }),
            onChange: function (value) { app.switchStudent(value); }
          }) : null
        ]));
      }

      if (state.demo) {
        left.appendChild(ui.badge('демо-режим', 'orange', 'Данные генерируются локально, реальный МЭШ не опрашивается'));
      }

      var token = state.token || {};
      right.appendChild(h('div', { class: 'topbar-token', title: 'Токен: ' + (token.mask || '—') + (token.expiresAt ? ' · до ' + new Date(token.expiresAt).toLocaleString('ru-RU') : '') }, [
        h('span', { class: 'token-dot token-dot-' + (state.authenticated ? (token.expired ? 'warn' : 'ok') : 'off') }),
        h('span', { class: 'muted small', text: state.authenticated ? 'токен ' + (token.mask || '') : 'нет токена' })
      ]));

      right.appendChild(ui.button({
        label: '', icon: 'refresh', kind: 'ghost', title: 'Обновить данные (Ctrl+R)',
        onClick: function () { app.refresh(true); }
      }));
      right.appendChild(ui.button({
        label: '', icon: platform.settings.get().theme === 'light' ? 'moon' : 'sun', kind: 'ghost', title: 'Переключить тему',
        onClick: function () {
          var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
          platform.settings.set({ theme: next });
          platform.applyTheme(next);
          app.renderTopbar();
        }
      }));
      right.appendChild(ui.button({
        label: '', icon: 'lock', kind: 'ghost', title: 'Войти заново / обновить токен',
        onClick: function () { app.showLogin(); }
      }));
      right.appendChild(ui.button({
        label: '', icon: 'logout', kind: 'ghost', title: 'Выйти из МЭШ',
        onClick: function () {
          ui.confirm('Выйти из МЭШ и удалить токен с устройства?', { danger: true, okText: 'Выйти' }).then(function (confirmed) {
            if (!confirmed) return;
            platform.signOut().then(function () { app.onSignedOut(); });
          });
        }
      }));
    },

    // ---------------------------------------------------------------- вкладки ---
    go: function (viewId) {
      var definition = ui.views[viewId];
      if (!definition) return;
      app.viewId = viewId;

      var previous = app.instances[app.currentViewKey];
      if (previous && previous.hide) previous.hide();

      var host = ui.qs('#view-host');
      ui.clear(host);

      var instance = app.instances[viewId];
      if (!instance) {
        instance = definition.create(app.context());
        app.instances[viewId] = instance;
      }
      app.currentViewKey = viewId;
      host.appendChild(instance.el);
      app.renderShell();
      var result = instance.show ? instance.show() : null;
      if (result && result.catch) result.catch(function (error) { ui.toast(error.message || String(error), { type: 'error' }); });
      platform.settings.set({ lastView: viewId });
      return result;
    },

    refresh: function (force) {
      var instance = app.instances[app.viewId];
      var reloadState = force ? app.loadState() : Promise.resolve(app.state);
      return reloadState.then(function () {
        app.renderTopbar();
        if (instance && instance.refresh) return instance.refresh();
      });
    },

    switchStudent: function (studentId) {
      return platform.selectStudent(studentId).then(function (state) {
        app.state = state;
        app.instances = {}; // данные другого ученика — пересоздаём вкладки
        ui.toast('Ученик переключён', { type: 'success' });
        app.renderTopbar();
        app.go(app.viewId || 'ranking');
      }).catch(function (error) { ui.toast(error.message, { type: 'error' }); });
    },

    // ------------------------------------------------------------------ вход ---
    showLogin: function () {
      var demo = !!(app.state && app.state.demo);
      return ui.Login.show({
        demo: demo,
        onSuccess: function (state) {
          app.state = state;
          app.instances = {};
          app.startShell();
        }
      });
    },

    onSignedOut: function () {
      app.state = null;
      app.instances = {};
      ui.clear(ui.qs('#view-host'));
      ui.clear(ui.qs('#nav'));
      app.showLogin();
    },

    startShell: function () {
      ui.qs('#app').classList.add('app-visible');
      app.renderShell();
      app.renderTopbar();
      var settings = platform.settings.get();
      var initial = settings.lastView && ui.views[settings.lastView] ? settings.lastView : (settings.defaultView || 'ranking');
      app.go(ui.views[initial] ? initial : 'ranking');
      app.setupAutoRefresh();
    },

    setupAutoRefresh: function () {
      if (app.timer) clearInterval(app.timer);
      var minutes = Number(platform.settings.get().autoRefreshMinutes || 0);
      if (!minutes) return;
      app.timer = setInterval(function () {
        if (document.hidden) return;
        var instance = app.instances[app.viewId];
        if (instance && instance.refresh) instance.refresh();
      }, minutes * 60000);
    },

    // ----------------------------------------------------------------- события ---
    loadState: function () {
      return platform.state().then(function (state) {
        app.state = state;
        return state;
      });
    },

    bindPlatformEvents: function () {
      platform.on('token', function (payload) {
        var token = payload && payload.token ? payload.token : payload;
        ui.toast('Токен МЭШ обновлён автоматически', {
          type: 'success',
          detail: payload && payload.mask ? 'новое значение: ' + payload.mask : (typeof token === 'string' ? util.asStr(token).slice(0, 8) + '…' : ''),
          timeout: 3000
        });
        app.loadState().then(app.renderTopbar);
      });
      platform.on('state', function (state) {
        app.state = state;
        app.renderTopbar();
      });
      platform.on('status', function (payload) {
        if (payload && payload.message) ui.toast(payload.message, { type: payload.type || 'info' });
      });
      platform.on('error', function (payload) {
        ui.toast('Ошибка платформы', { type: 'error', detail: payload && (payload.message || payload) });
      });
    },

    bindShortcuts: function () {
      document.addEventListener('keydown', function (event) {
        if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
          if (event.key === 'Escape' && event.target.blur) event.target.blur();
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
          event.preventDefault();
          app.refresh(true);
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          var search = document.querySelector('input[type="search"]');
          if (search) search.focus();
          return;
        }
        var index = parseInt(event.key, 10);
        if (index >= 1 && index <= 9) {
          var ids = Object.keys(ui.views);
          if (ids[index - 1]) app.go(ids[index - 1]);
        }
      });
    },

    context: function () {
      return {
        version: VERSION,
        state: app.currentState,
        student: app.student,
        openRanking: app.openRanking,
        showLogin: app.showLogin,
        reloadState: function () { return app.loadState().then(app.renderTopbar); },
        onStudentChanged: function () { app.loadState().then(function () { app.instances = {}; app.go(app.viewId); }); },
        onSignOut: app.onSignedOut,
        onSettingsChanged: function (patch) {
          if (patch && patch.autoRefreshMinutes !== undefined) app.setupAutoRefresh();
        }
      };
    },

    // ------------------------------------------------------------------- старт ---
    boot: function () {
      platform.applyTheme();
      app.bindPlatformEvents();
      app.bindShortcuts();
      app.loadState().then(function (state) {
        if (state && state.authenticated && (state.children || []).length) {
          app.startShell();
        } else {
          app.showLogin();
        }
      }).catch(function (error) {
        ui.toast('Не удалось получить состояние', { type: 'error', detail: error.message });
        app.showLogin();
      });
    }
  };

  root.MeshApp = app;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', app.boot);
  else app.boot();
})(typeof self !== 'undefined' ? self : this);
