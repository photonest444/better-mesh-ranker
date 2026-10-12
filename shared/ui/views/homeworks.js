/*!
 * Mesh Ranker — вкладка «Домашние задания».
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var format = ui.format;
  var util = ui.util;
  var platform = root.MeshPlatform;

  function create(ctx) {
    var state = {
      from: util.addDays(util.todayIso(), -7),
      to: util.addDays(util.todayIso(), 7),
      subjectFilter: 'all',
      onlyUndone: false,
      subjects: [],
      homeworks: [],
      loading: false
    };

    var controlsHost = h('div', { class: 'view-controls' });
    var kpiHost = h('div', { class: 'kpi-row' });
    var tableHost = h('div', {});
    var rootEl = h('div', { class: 'view view-homeworks' }, [
      controlsHost,
      kpiHost,
      ui.card({
        title: 'Домашние задания',
        subtitle: 'Клик по строке — полный текст задания',
        body: tableHost,
        actions: [ui.button({ label: 'Печать', kind: 'ghost', icon: 'print', onClick: function () { window.print(); } })]
      })
    ]);

    var table = ui.DataTable(tableHost, {
      columns: [
        { key: 'assignedOn', title: 'Выдано', type: 'date', width: '110px' },
        { key: 'subjectName', title: 'Предмет' },
        {
          key: 'description', title: 'Задание',
          render: function (row) { return h('span', { class: 'hw-text', text: format.truncate(row.description, 90) }); }
        },
        {
          key: 'dueDate', title: 'Сдать до', type: 'date', width: '110px',
          render: function (row) {
            if (!row.dueDate) return h('span', { class: 'muted', text: '—' });
            var overdue = util.daysBetween(util.todayIso(), row.dueDate) < 0 && !row.isDone;
            return h('span', { class: overdue ? 'delta-down' : '', text: format.dateShort(row.dueDate) });
          }
        },
        {
          key: 'isDone', title: 'Статус', type: 'boolean', width: '130px',
          render: function (row) { return ui.badge(row.isDone ? 'выполнено' : 'не выполнено', row.isDone ? 'green' : 'orange'); }
        },
        {
          key: 'attachments', title: 'Файлы', sortable: false, width: '80px',
          render: function (row) {
            var files = row.attachments || [];
            return files.length ? ui.badge(String(files.length), 'blue', 'Вложений: ' + files.length) : h('span', { class: 'muted', text: '—' });
          }
        }
      ],
      rows: [],
      pageSize: 25,
      sort: { key: 'assignedOn', dir: 'desc', type: 'date' },
      search: { enabled: true, placeholder: 'Поиск по заданию…' },
      exportTitle: 'Домашние задания',
      exportName: 'homeworks',
      exportDate: state.from,
      empty: { title: 'Заданий за период нет', text: 'Домашние задания обычно появляются после 14:00.' },
      onRowClick: openHomework
    });

    function openHomework(row) {
      ui.modal({
        title: row.subjectName,
        subtitle: 'Выдано ' + format.dateRu(row.assignedOn, { weekday: true }) + (row.dueDate ? ' · сдать до ' + format.dateShort(row.dueDate) : ''),
        size: 'md',
        body: [
          h('div', { class: 'hw-full', text: row.description || 'Описание не указано' }),
          row.attachments && row.attachments.length ? h('div', { class: 'modal-block' }, [
            h('div', { class: 'muted small', text: 'Вложения' }),
            h('ul', { class: 'list' }, row.attachments.map(function (file) {
              return h('li', { text: file.name || file.file_name || 'файл' });
            }))
          ]) : null,
          h('div', { class: 'modal-stats' }, [
            ui.stat({ label: 'Статус', value: row.isDone ? 'выполнено' : 'не выполнено', color: row.isDone ? 'green' : 'orange' }),
            ui.stat({ label: 'Вес в журнале', value: row.raw && row.raw.weight ? row.raw.weight : '—' })
          ])
        ],
        actions: [
          {
            label: 'Скопировать задание', kind: 'ghost', icon: 'copy', close: false,
            onClick: function () {
              var text = row.subjectName + ' (' + format.dateShort(row.assignedOn) + '): ' + row.description;
              if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { ui.toast('Задание скопировано', { type: 'success' }); });
            }
          },
          { label: 'Закрыть', kind: 'primary' }
        ]
      });
    }

    function renderControls() {
      ui.clear(controlsHost);
      var presets = [
        { label: 'Прошлая неделя', from: -14, to: -7 },
        { label: 'Эта неделя', from: -7, to: 7 },
        { label: 'Месяц', from: -30, to: 1 }
      ].map(function (preset) {
        var active = state.from === util.addDays(util.todayIso(), preset.from) && state.to === util.addDays(util.todayIso(), preset.to);
        return ui.button({
          label: preset.label,
          kind: active ? 'primary' : 'ghost',
          onClick: function () {
            state.from = util.addDays(util.todayIso(), preset.from);
            state.to = util.addDays(util.todayIso(), preset.to);
            load();
          }
        });
      });

      var subjectOptions = [{ value: 'all', label: 'Все предметы' }].concat(state.subjects.map(function (subject) {
        return { value: String(subject.id), label: subject.name };
      }));

      controlsHost.appendChild(h('div', { class: 'controls-row' }, [
        h('div', { class: 'controls-group' }, [
          h('span', { class: 'controls-label', text: 'С' }),
          h('input', { class: 'input input-date', type: 'date', value: state.from, onchange: function (e) { state.from = e.target.value; load(); } }),
          h('span', { class: 'controls-label', text: 'по' }),
          h('input', { class: 'input input-date', type: 'date', value: state.to, onchange: function (e) { state.to = e.target.value; load(); } })
        ]),
        h('div', { class: 'controls-group' }, presets),
        h('div', { class: 'controls-group controls-right' }, [
          ui.field({ type: 'select', value: state.subjectFilter, options: subjectOptions, className: 'field-compact', onChange: function (value) { state.subjectFilter = value; applyFilter(); } }),
          ui.field({ type: 'checkbox', label: 'Только невыполненные', value: state.onlyUndone, onChange: function (value) { state.onlyUndone = value; applyFilter(); } }),
          ui.button({ label: 'Обновить', kind: 'ghost', icon: 'refresh', onClick: function () { load(); } })
        ])
      ]));
    }

    function applyFilter() {
      var rows = state.homeworks.slice();
      if (state.subjectFilter !== 'all') rows = rows.filter(function (row) { return String(row.subjectId) === String(state.subjectFilter); });
      if (state.onlyUndone) rows = rows.filter(function (row) { return !row.isDone; });
      table.setRows(rows);
    }

    function renderKpis() {
      ui.clear(kpiHost);
      var rows = state.homeworks;
      var done = rows.filter(function (row) { return row.isDone; }).length;
      var today = util.todayIso();
      var dueToday = rows.filter(function (row) { return row.dueDate === today && !row.isDone; }).length;
      var overdue = rows.filter(function (row) { return row.dueDate && row.dueDate < today && !row.isDone; }).length;
      var bySubject = {};
      rows.forEach(function (row) { bySubject[row.subjectName] = (bySubject[row.subjectName] || 0) + 1; });
      var top = Object.keys(bySubject).sort(function (a, b) { return bySubject[b] - bySubject[a]; })[0];
      kpiHost.appendChild(ui.stat({ label: 'Всего заданий', value: rows.length, hint: format.dateRangeText(state.from, state.to) }));
      kpiHost.appendChild(ui.stat({ label: 'Выполнено', value: done, color: 'green', hint: rows.length ? Math.round((done / rows.length) * 100) + '% от всех' : '' }));
      kpiHost.appendChild(ui.stat({ label: 'Не выполнено', value: rows.length - done, color: overdue ? 'red' : 'orange', hint: overdue ? 'просрочено: ' + overdue : 'без просрочек' }));
      kpiHost.appendChild(ui.stat({ label: 'Сдать сегодня', value: dueToday, color: dueToday ? 'orange' : 'default' }));
      kpiHost.appendChild(ui.stat({ label: 'Самый нагруженный', value: top || '—', hint: top ? bySubject[top] + ' заданий' : '' }));
    }

    function load() {
      var child = ctx.student && ctx.student();
      if (!child) return Promise.resolve();
      renderControls();
      table.setLoading(true);
      var subjectsPromise = state.subjects.length ? Promise.resolve() : platform.subjects({ studentId: child.id, date: util.todayIso() }).then(function (result) {
        state.subjects = result.subjects || [];
        renderControls();
      });
      return subjectsPromise.then(function () {
        return platform.homeworks({ studentId: child.id, from: state.from, to: state.to });
      }).then(function (result) {
        state.homeworks = result.homeworks || [];
        applyFilter();
        renderKpis();
      }).catch(function (error) {
        table.setError(error.message || String(error));
        ui.toast('Домашние задания не загрузились', { type: 'error', detail: error.message });
      });
    }

    return {
      el: rootEl,
      show: function () { return load(); },
      hide: function () { },
      refresh: function () { return load(); }
    };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.views = root.MeshUI.views || {};
  root.MeshUI.views.homeworks = {
    id: 'homeworks',
    title: 'Домашние задания',
    icon: 'book',
    hint: 'Что задано и что уже сделано',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
