/*!
 * Mesh Ranker — вкладка «Профиль»: ученик, токен МЭШ, диагностика сессии.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var format = ui.format;
  var util = ui.util;
  var platform = root.MeshPlatform;

  function create(ctx) {
    var rootEl = h('div', { class: 'view view-profile' });

    function studentCard(child, activeId) {
      var isActive = String(child.id) === String(activeId);
      return h('div', { class: 'person-card' + (isActive ? ' person-active' : '') }, [
        h('div', { class: 'person-avatar', text: (child.firstName || child.name || '?').slice(0, 1) }),
        h('div', { class: 'person-body' }, [
          h('div', { class: 'person-name', text: child.name }),
          h('div', { class: 'muted small', text: [child.className, child.schoolName].filter(Boolean).join(' · ') || 'класс не указан' }),
          h('div', { class: 'muted small', text: 'personId: ' + child.personId.slice(0, 12) + '…' })
        ]),
        isActive
          ? ui.badge('активен', 'green')
          : ui.button({
            label: 'Выбрать', kind: 'ghost', onClick: function () {
              platform.selectStudent(child.id).then(function () {
                ui.toast('Активный ученик: ' + child.name, { type: 'success' });
                if (ctx.onStudentChanged) ctx.onStudentChanged();
              }).catch(function (error) { ui.toast(error.message, { type: 'error' }); });
            }
          })
      ]);
    }

    function tokenCard(state) {
      var token = state.token || {};
      var expiresText = 'неизвестно';
      var hoursLeft = null;
      if (token.expiresAt) {
        hoursLeft = Math.round((token.expiresAt - Date.now()) / 3600000);
        expiresText = format.dateShort(new Date(token.expiresAt).toISOString()) + ' ' +
          new Date(token.expiresAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) +
          (hoursLeft !== null ? ' (через ' + hoursLeft + ' ч.)' : '');
      }
      var status = token.expired ? ui.badge('истёк', 'red') : ui.badge('действует', 'green');
      return ui.card({
        title: 'Токен МЭШ',
        subtitle: 'Приложение хранит токен на устройстве и обновляет его автоматически',
        body: [
          h('div', { class: 'kv-grid' }, [
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Состояние' }), h('span', { class: 'kv-value' }, status)]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Тип' }), h('span', { class: 'kv-value', text: token.kind === 'jwt' ? 'JWT (с expires_at)' : 'серверный строковый' })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Значение' }), h('span', { class: 'kv-value mono', text: token.mask || '—' })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Истекает' }), h('span', { class: 'kv-value', text: expiresText })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Последнее обновление' }), h('span', { class: 'kv-value', text: state.lastRefresh ? format.relativeTime(state.lastRefresh) : 'в этой сессии не обновлялся' })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Хранилище' }), h('span', { class: 'kv-value', text: storageText() })])
          ]),
          h('p', { class: 'muted small', text: 'Полное значение токена нигде не показывается: в интерфейсе — только маска. Обновление выполняется запросом ' + MeshCore.loginUrl() + ' с тем же токеном, поэтому повторный вход не нужен.' }),
          h('div', { class: 'card-actions-row' }, [
            ui.button({
              label: 'Обновить токен сейчас', kind: 'primary', icon: 'refresh',
              onClick: function () {
                ui.toast('Обновляем токен МЭШ…', { type: 'info' });
                platform.refreshToken().then(function (next) {
                  ui.toast(next.authenticated ? 'Токен обновлён' : 'МЭШ не выдал новый токен', { type: next.authenticated ? 'success' : 'warn' });
                  if (ctx.reloadState) ctx.reloadState();
                  else render();
                }).catch(function (error) { ui.toast(error.message, { type: 'error' }); });
              }
            }),
            ui.button({
              label: 'Войти заново', kind: 'ghost', icon: 'lock',
              onClick: function () { if (ctx.showLogin) ctx.showLogin(); }
            }),
            ui.button({
              label: 'Выйти', kind: 'danger', icon: 'logout',
              onClick: function () {
                ui.confirm('Выйти из МЭШ и удалить сохранённый токен с этого устройства?', { danger: true, okText: 'Выйти' }).then(function (confirmed) {
                  if (!confirmed) return;
                  platform.signOut().then(function () {
                    ui.toast('Вы вышли из МЭШ', { type: 'success' });
                    if (ctx.onSignOut) ctx.onSignOut();
                  }).catch(function (error) { ui.toast(error.message, { type: 'error' }); });
                });
              }
            })
          ])
        ]
      });
    }

    function storageText() {
      if (platform.mode === 'electron') return 'системное хранилище ОС (safeStorage: DPAPI / Keychain / libsecret)';
      if (platform.mode === 'android') return 'приватные SharedPreferences приложения';
      return 'локальный файл .preview/session.json только на этом компьютере';
    }

    function render() {
      var state = ctx.state ? ctx.state() : {};
      ui.clear(rootEl);
      var profile = state.profile || {};
      var children = state.children || [];

      rootEl.appendChild(h('div', { class: 'kpi-row' }, [
        ui.stat({ label: 'Учеников в профиле', value: children.length, hint: children.map(function (c) { return c.shortName || c.name; }).join(', ') }),
        ui.stat({ label: 'Подключение', value: state.demo ? 'демо-данные' : 'МЭШ онлайн', hint: state.host || '' }),
        ui.stat({ label: 'Платформа', value: platform.mode, hint: 'мост данных и хранилище токена' }),
        ui.stat({ label: 'Токен', value: state.token && state.token.expired ? 'истёк' : state.authenticated ? 'активен' : 'нет', color: state.authenticated ? 'green' : 'orange' })
      ]));

      rootEl.appendChild(ui.card({
        title: 'Ученики',
        subtitle: 'Рейтинг, оценки и задания берутся для активного ученика. Переключение мгновенное.',
        body: h('div', { class: 'person-list' }, children.length ? children.map(function (child) { return studentCard(child, state.activeStudentId); }) : [
          ui.empty({ title: 'В профиле нет детей', text: 'Проверьте, что вход выполнен под ролью родителя (roleId=1).' })
        ])
      }));

      rootEl.appendChild(ui.card({
        title: 'Родитель',
        subtitle: 'Учётная запись, под которой выполнен вход',
        body: h('div', { class: 'kv-grid' }, [
          h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Имя' }), h('span', { class: 'kv-value', text: profile.parent ? profile.parent.name : '—' })]),
          h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'E-mail' }), h('span', { class: 'kv-value', text: (profile.parent && profile.parent.email) || '—' })]),
          h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Телефон' }), h('span', { class: 'kv-value', text: (profile.parent && profile.parent.phone) || '—' })]),
          h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Подсистема' }), h('span', { class: 'kv-value', text: 'familyweb (роль ' + MeshCore.ROLE_ID + ')' })])
        ])
      }));

      rootEl.appendChild(tokenCard(state));

      rootEl.appendChild(ui.card({
        title: 'Данные и экспорт',
        subtitle: 'Все данные можно забрать с собой',
        body: [
          h('p', { class: 'muted small', text: 'Экспорт выгружает профиль, рейтинг, оценки и задания в один CSV-набор по запросу. Это удобно для отчётов родителям или анализа в Excel.' }),
          h('div', { class: 'card-actions-row' }, [
            ui.button({
              label: 'Экспортировать профиль (JSON)', kind: 'ghost', icon: 'download',
              onClick: function () {
                var text = JSON.stringify({
                  exportedAt: new Date().toISOString(),
                  platform: platform.mode,
                  parent: profile.parent,
                  children: children,
                  token: { kind: state.token && state.token.kind, mask: state.token && state.token.mask, expiresAt: state.token && state.token.expiresAt }
                }, null, 2);
                ui.saveTextFile(format.exportFileName('profile', util.todayIso(), 'json'), text, 'application/json');
              }
            }),
            ui.button({
              label: 'Очистить кэш имён', kind: 'ghost', icon: 'trash',
              onClick: function () {
                platform.call && platform.call('clearCache');
                ui.toast('Кэш имён будет перезапрошен при следующем открытии рейтинга', { type: 'success' });
              }
            })
          ])
        ]
      }));
    }

    return { el: rootEl, show: function () { render(); }, hide: function () { }, refresh: render };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.views = root.MeshUI.views || {};
  root.MeshUI.views.profile = {
    id: 'profile',
    title: 'Профиль',
    icon: 'person',
    hint: 'Ученик, токен МЭШ и экспорт данных',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
