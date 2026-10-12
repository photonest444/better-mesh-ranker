/*!
 * Mesh Ranker — вкладка «Настройки».
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var util = ui.util;
  var platform = root.MeshPlatform;

  function create(ctx) {
    var rootEl = h('div', { class: 'view view-settings' });

    function current() { return platform.settings.get(); }

    function field(options) {
      return ui.field(Object.assign({
        onChange: function (value) {
          var patch = {};
          patch[options.key] = value;
          platform.settings.set(patch);
          if (options.key === 'theme') platform.applyTheme(value);
          if (ctx.onSettingsChanged) ctx.onSettingsChanged(patch);
          ui.toast('Настройка сохранена', { type: 'success', timeout: 1600 });
        }
      }, options));
    }

    function render() {
      var settings = current();
      ui.clear(rootEl);

      rootEl.appendChild(ui.card({
        title: 'Внешний вид',
        subtitle: 'Тема, плотность таблиц и размер страниц',
        body: [
          field({
            key: 'theme', label: 'Тема', type: 'select', value: settings.theme,
            options: [{ value: 'auto', label: 'Как в системе' }, { value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }]
          }),
          field({
            key: 'pageSize', label: 'Строк на странице', type: 'select', value: String(settings.pageSize),
            options: [{ value: '10', label: '10' }, { value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }, { value: '0', label: 'Все строки' }]
          }),
          field({ key: 'denseTables', label: 'Компактные таблицы', type: 'checkbox', value: settings.denseTables, hint: 'меньше отступов — больше строк на экране' }),
          field({ key: 'showHistogram', label: 'Показывать гистограмму класса', type: 'checkbox', value: settings.showHistogram }),
          field({
            key: 'defaultView', label: 'Вкладка при запуске', type: 'select', value: settings.defaultView,
            options: Object.keys(root.MeshUI.views).map(function (id) {
              var view = root.MeshUI.views[id];
              return { value: id, label: view.title };
            })
          })
        ]
      }));

      rootEl.appendChild(ui.card({
        title: 'Данные и сеть',
        subtitle: 'Как приложение ведёт себя с МЭШ',
        body: [
          field({ key: 'onlyMyClass', label: 'Показывать только свой класс', type: 'checkbox', value: settings.onlyMyClass }),
          field({
            key: 'autoRefreshMinutes', label: 'Автообновление данных', type: 'select', value: String(settings.autoRefreshMinutes || 0),
            options: [{ value: '0', label: 'выключено' }, { value: '5', label: 'каждые 5 минут' }, { value: '15', label: 'каждые 15 минут' }, { value: '60', label: 'каждый час' }]
          }),
          field({ key: 'autoRefreshToken', label: 'Автоматически обновлять токен МЭШ', type: 'checkbox', value: settings.autoRefreshToken, hint: 'при 401 приложение само запрашивает новый токен и повторяет запрос' }),
          h('div', { class: 'card-actions-row' }, [
            ui.button({
              label: 'Сбросить настройки', kind: 'ghost', icon: 'trash',
              onClick: function () {
                ui.confirm('Вернуть все настройки к значениям по умолчанию?').then(function (confirmed) {
                  if (!confirmed) return;
                  platform.settings.reset();
                  platform.applyTheme('auto');
                  ui.toast('Настройки сброшены', { type: 'success' });
                  render();
                });
              }
            }),
            ui.button({
              label: 'Проверить связь с МЭШ', kind: 'ghost', icon: 'refresh',
              onClick: function () {
                ui.toast('Проверяем соединение…', { type: 'info', timeout: 2000 });
                platform.profile().then(function () {
                  ui.toast('Соединение с МЭШ в порядке', { type: 'success' });
                }).catch(function (error) {
                  ui.toast('Нет связи с МЭШ', { type: 'error', detail: error.message });
                });
              }
            })
          ])
        ]
      }));

      rootEl.appendChild(ui.card({
        title: 'О приложении',
        subtitle: 'Mesh Ranker: неофициальный клиент рейтинга МЭШ',
        body: [
          h('div', { class: 'kv-grid' }, [
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Версия' }), h('span', { class: 'kv-value', text: (ctx.version && ctx.version.app) || '1.0.0' })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Ядро' }), h('span', { class: 'kv-value', text: (ctx.version && ctx.version.core) || '1.0.0' })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Платформа' }), h('span', { class: 'kv-value', text: platform.mode })]),
            h('div', { class: 'kv' }, [h('span', { class: 'kv-key', text: 'Ссылка входа' }), h('span', { class: 'kv-value mono small', text: platform.loginUrl() })])
          ]),
          h('p', { class: 'muted small', text: 'Приложение только читает данные через открытые методы МЭШ и ничего не изменяет в электронном дневнике. Токен хранится локально и не передаётся третьим лицам.' }),
          h('div', { class: 'card-actions-row' }, [
            ui.button({
              label: 'Открыть МЭШ в браузере', kind: 'ghost',
              onClick: function () { window.open(platform.loginUrl(), '_blank', 'noopener'); }
            }),
            ui.button({
              label: 'Копировать ссылку входа', kind: 'ghost', icon: 'copy',
              onClick: function () {
                if (navigator.clipboard) navigator.clipboard.writeText(platform.loginUrl()).then(function () { ui.toast('Ссылка скопирована', { type: 'success' }); });
              }
            })
          ])
        ]
      }));

      rootEl.appendChild(ui.card({
        title: 'Токен и приватность',
        subtitle: 'Что именно хранится на устройстве',
        body: h('ul', { class: 'list' }, [
          h('li', { text: 'Токен МЭШ и id ученика — в защищённом хранилище платформы; показывается только маска.' }),
          h('li', { text: 'Кэш имён одноклассников — чтобы рейтинг открывался мгновенно, без десятков запросов.' }),
          h('li', { text: 'Настройки интерфейса — локально.' }),
          h('li', { text: 'Никакой аналитики и отправки данных на сторонние серверы.' })
        ])
      }));
    }

    return { el: rootEl, show: function () { render(); }, hide: function () { }, refresh: render };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.views = root.MeshUI.views || {};
  root.MeshUI.views.settings = {
    id: 'settings',
    title: 'Настройки',
    icon: 'star',
    hint: 'Тема, автообновление, приватность',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
