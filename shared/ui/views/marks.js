/*!
 * Mesh Ranker — вкладка «Оценки»: журнал оценок за период + сводка по предметам.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var stats = ui.stats;
  var format = ui.format;
  var util = ui.util;
  var platform = root.MeshPlatform;

  var PRESETS = [
    { label: '7 дней', days: 7 },
    { label: '30 дней', days: 30 },
    { label: 'Четверть', days: 60 },
    { label: 'Учебный год', schoolYear: true }
  ];

  function create(ctx) {
    var state = {
      from: util.addDays(util.todayIso(), -30),
      to: util.todayIso(),
      subjects: [],
      subjectFilter: 'all',
      marks: [],
      summary: null,
      onlyWithValue: false,
      loading: false
    };

    var controlsHost = h('div', { class: 'view-controls' });
    var kpiHost = h('div', { class: 'kpi-row' });
    var chartsHost = h('div', { class: 'view-section' });
    var tableHost = h('div', {});
    var summaryHost = h('div', {});
    var rootEl = h('div', { class: 'view view-marks' }, [
      controlsHost,
      kpiHost,
      chartsHost,
      ui.card({ title: 'Журнал оценок', subtitle: 'Все оценки за выбранный период', body: tableHost }),
      ui.card({ title: 'Итоги по предметам', subtitle: 'Средний балл и распределение внутри периода', body: summaryHost })
    ]);

    var table = ui.DataTable(tableHost, {
      columns: [
        { key: 'date', title: 'Дата', type: 'date', width: '110px' },
        { key: 'subjectName', title: 'Предмет' },
        {
          key: 'value', title: 'Оценка', type: 'number', width: '84px', align: 'center',
          render: function (row) { return h('span', { class: 'mark mark-' + stats.gradeColor(row.value), text: row.value === null ? '—' : row.value }); }
        },
        { key: 'controlForm', title: 'Форма контроля' },
        { key: 'weight', title: 'Вес', type: 'number', width: '70px' },
        { key: 'comment', title: 'Комментарий', render: function (row) { return row.comment ? format.truncate(row.comment, 80) : h('span', { class: 'muted', text: '—' }); } }
      ],
      rows: [],
      pageSize: 25,
      sort: { key: 'date', dir: 'desc', type: 'date' },
      search: { enabled: true, placeholder: 'Поиск по предмету, форме, комментарию…' },
      exportTitle: 'Оценки за период',
      exportName: 'marks',
      exportDate: state.from,
      empty: { title: 'Оценок за период нет', text: 'Измените период или выберите другой предмет.' }
    });

    var summaryTable = ui.DataTable(summaryHost, {
      columns: [
        { key: 'subjectName', title: 'Предмет' },
        { key: 'count', title: 'Оценок', type: 'number' },
        {
          key: 'average', title: 'Средний', type: 'number', summary: true,
          render: function (row) { return h('span', { class: 'mark mark-' + row.color, text: format.markShort(row.average) }); }
        },
        { key: 'median', title: 'Медиана', type: 'number' },
        { key: 'bar', title: 'Уровень', sortable: false, render: function (row) { return ui.bar(row.average, 5, { color: row.color }); } },
        {
          key: 'spark', title: 'Последние оценки', sortable: false,
          render: function (row) {
            return h('span', { class: 'spark' }, row.marks.slice(0, 8).map(function (mark) {
              return h('span', { class: 'spark-mark mark-' + stats.gradeColor(mark.value), title: format.dateShort(mark.date) + ' · ' + mark.controlForm, text: mark.value === null ? '—' : mark.value });
            }));
          }
        }
      ],
      rows: [],
      pageSize: 0,
      sort: { key: 'average', dir: 'desc', type: 'number' },
      search: { enabled: false },
      exportTitle: 'Итоги по предметам за период',
      exportName: 'marks-by-subject'
    });

    function renderControls() {
      ui.clear(controlsHost);
      var presetButtons = PRESETS.map(function (preset) {
        var active = false;
        if (preset.schoolYear) {
          active = state.from === util.schoolYearStart(state.to);
        } else {
          active = state.from === util.addDays(state.to, -preset.days);
        }
        return ui.button({
          label: preset.label,
          kind: active ? 'primary' : 'ghost',
          onClick: function () {
            if (preset.schoolYear) state.from = util.schoolYearStart(state.to);
            else state.from = util.addDays(state.to, -preset.days);
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
        h('div', { class: 'controls-group' }, presetButtons),
        h('div', { class: 'controls-group controls-right' }, [
          ui.field({
            type: 'select',
            value: state.subjectFilter,
            options: subjectOptions,
            className: 'field-compact',
            onChange: function (value) { state.subjectFilter = value; applyFilter(); }
          }),
          ui.field({
            type: 'checkbox',
            label: 'Только с оценкой',
            value: state.onlyWithValue,
            onChange: function (value) { state.onlyWithValue = value; applyFilter(); }
          }),
          ui.button({ label: 'Обновить', kind: 'ghost', icon: 'refresh', onClick: function () { load(); } })
        ])
      ]));
    }

    function applyFilter() {
      var rows = state.marks.slice();
      if (state.subjectFilter !== 'all') {
        rows = rows.filter(function (row) { return String(row.subjectId) === String(state.subjectFilter); });
      }
      if (state.onlyWithValue) rows = rows.filter(function (row) { return row.value !== null; });
      table.setRows(rows);
    }

    function renderKpis() {
      ui.clear(kpiHost);
      var summary = state.summary || {};
      kpiHost.appendChild(ui.stat({
        label: 'Средний балл',
        value: format.markShort(summary.average),
        color: stats.gradeColor(summary.average),
        hint: 'взвешенный: ' + format.markShort(summary.weightedAverage)
      }));
      kpiHost.appendChild(ui.stat({ label: 'Оценок за период', value: summary.count || 0, hint: 'с числовым значением: ' + (summary.withValue || 0) }));
      kpiHost.appendChild(ui.stat({ label: 'Медиана', value: format.markShort(summary.median) }));
      kpiHost.appendChild(ui.stat({ label: 'Лучшая', value: summary.best === null || summary.best === undefined ? '—' : summary.best, color: 'green' }));
      kpiHost.appendChild(ui.stat({ label: 'Последняя оценка', value: summary.lastMark ? summary.lastMark.value : '—', hint: summary.lastMark ? summary.lastMark.subjectName + ' · ' + format.dateShort(summary.lastMark.date) : 'нет данных' }));
      kpiHost.appendChild(ui.stat({
        label: 'Период',
        value: util.daysBetween(state.from, state.to) + 1,
        unit: ' дн.',
        hint: format.dateRangeText(state.from, state.to)
      }));
    }

    function renderCharts() {
      ui.clear(chartsHost);
      var summary = state.summary;
      if (!summary || !summary.byValue) return;
      var max = summary.byValue.reduce(function (acc, item) { return Math.max(acc, item.count); }, 1);
      chartsHost.appendChild(ui.card({
        title: 'Распределение оценок',
        subtitle: 'Сколько каких оценок получено за период',
        body: h('div', { class: 'histogram histogram-horizontal' }, [
          h('div', { class: 'histogram-bars' }, summary.byValue.map(function (item) {
            return h('div', { class: 'histogram-bar', title: item.value + ': ' + item.count }, [
              h('div', { class: 'histogram-fill bar-' + item.color, style: { height: Math.round((item.count / max) * 100) + '%' } }),
              h('span', { class: 'histogram-count', text: item.count || '' })
            ]);
          })),
          h('div', { class: 'histogram-labels' }, summary.byValue.map(function (item) { return h('span', { text: String(item.value) }); }))
        ])
      }));
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
        return platform.marks({ studentId: child.id, from: state.from, to: state.to });
      }).then(function (result) {
        state.marks = result.marks || [];
        state.summary = result.summary || null;
        applyFilter();
        summaryTable.setRows((state.summary && state.summary.bySubject) || []);
        renderKpis();
        renderCharts();
      }).catch(function (error) {
        table.setError(error.message || String(error));
        ui.toast('Оценки не загрузились', { type: 'error', detail: error.message });
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
  root.MeshUI.views.marks = {
    id: 'marks',
    title: 'Оценки',
    icon: 'table',
    hint: 'Журнал оценок и итоги по предметам',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
