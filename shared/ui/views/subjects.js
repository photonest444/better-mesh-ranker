/*!
 * Mesh Ranker — вкладка «Предметы»: таблица предметов с местом и средним баллом.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var stats = ui.stats;
  var format = ui.format;
  var util = ui.util;
  var platform = root.MeshPlatform;

  function create(ctx) {
    var state = { date: util.todayIso(), loading: false, error: null, rows: [], minPlace: 1 };
    var controlsHost = h('div', { class: 'view-controls' });
    var kpiHost = h('div', { class: 'kpi-row' });
    var tableHost = h('div', {});
    var rootEl = h('div', { class: 'view view-subjects' }, [
      controlsHost,
      kpiHost,
      ui.card({ title: 'Предметы', subtitle: 'Клик по строке открывает рейтинг класса по предмету', body: tableHost })
    ]);

    var table = ui.DataTable(tableHost, {
      columns: [
        { key: 'name', title: 'Предмет' },
        {
          key: 'average', title: 'Мой средний балл', type: 'number', summary: true,
          render: function (row) { return h('span', { class: 'mark mark-' + stats.gradeColor(row.average), text: format.markShort(row.average) }); }
        },
        {
          key: 'place', title: 'Место', type: 'number',
          render: function (row) { return row.place ? ui.badge('#' + row.place, stats.placeColor(row.place, 30)) : h('span', { class: 'muted', text: '—' }); }
        },
        { key: 'status', title: 'Статус', render: function (row) { return ui.badge(row.status === 'TOP' ? 'сильный предмет' : row.status === 'MIDDLE' ? 'средний уровень' : row.status || '—', row.status === 'TOP' ? 'green' : 'default'); } },
        { key: 'trend', title: 'Тренд', render: function (row) { return row.trend ? h('span', { class: 'delta ' + (row.trend.indexOf('-') === 0 ? 'delta-down' : 'delta-up'), text: row.trend }) : h('span', { class: 'muted', text: '—' }); } },
        { key: 'isExam', title: 'Экзамен', type: 'boolean', render: function (row) { return row.isExam ? ui.badge('да', 'orange') : h('span', { class: 'muted', text: '—' }); } },
        { key: 'bar', title: 'Уровень', sortable: false, render: function (row) { return ui.bar(row.average, 5, { color: stats.gradeColor(row.average) }); } }
      ],
      rows: [],
      pageSize: 0,
      showSummary: true,
      sort: { key: 'average', dir: 'desc', type: 'number' },
      search: { enabled: true, placeholder: 'Поиск предмета…' },
      exportTitle: 'Предметы и средние баллы на ' + format.dateShort(state.date),
      exportName: 'subjects',
      empty: { title: 'Нет предметов с оценками', text: 'Выберите другую дату: МЭШ отдаёт оценки на конкретный снимок.' },
      onRowClick: function (row) {
        if (ctx.openRanking) ctx.openRanking(row.id);
        else ui.toast('Рейтинг по предмету «' + row.name + '» — откройте вкладку «Рейтинг»', { type: 'info' });
      }
    });

    function renderControls() {
      ui.clear(controlsHost);
      var presets = [
        { label: 'Сегодня', value: util.todayIso() },
        { label: '−14 дней', value: util.addDays(util.todayIso(), -14) },
        { label: '−30 дней', value: util.addDays(util.todayIso(), -30) },
        { label: '1 сентября', value: util.schoolYearStart(util.todayIso()) }
      ].map(function (preset) {
        return ui.button({
          label: preset.label,
          kind: state.date === preset.value ? 'primary' : 'ghost',
          onClick: function () { state.date = preset.value; load(); }
        });
      });
      controlsHost.appendChild(h('div', { class: 'controls-row' }, [
        h('div', { class: 'controls-group' }, [
          h('span', { class: 'controls-label', text: 'Дата снимка' }),
          h('input', { class: 'input input-date', type: 'date', value: state.date, onchange: function (e) { state.date = e.target.value; load(); } })
        ]),
        h('div', { class: 'controls-group' }, presets),
        h('div', { class: 'controls-group controls-right' }, [
          ui.button({ label: 'Обновить', kind: 'ghost', icon: 'refresh', onClick: function () { load(); } })
        ])
      ]));
    }

    function renderKpis() {
      ui.clear(kpiHost);
      var rows = state.rows;
      var withAverage = rows.filter(function (row) { return row.average !== null && row.average !== undefined; });
      var best = withAverage.slice().sort(function (a, b) { return b.average - a.average; })[0];
      var worst = withAverage.slice().sort(function (a, b) { return a.average - b.average; })[0];
      var exams = rows.filter(function (row) { return row.isExam; });
      kpiHost.appendChild(ui.stat({ label: 'Предметов', value: rows.length, hint: 'с оценками: ' + withAverage.length }));
      kpiHost.appendChild(ui.stat({
        label: 'Средний балл',
        value: format.markShort(stats.mean(withAverage.map(function (row) { return row.average; }))),
        color: stats.gradeColor(stats.mean(withAverage.map(function (row) { return row.average; })))
      }));
      kpiHost.appendChild(ui.stat({ label: 'Лучший предмет', value: best ? format.markShort(best.average) : '—', color: 'green', hint: best ? best.name : '' }));
      kpiHost.appendChild(ui.stat({ label: 'Слабый предмет', value: worst ? format.markShort(worst.average) : '—', color: 'orange', hint: worst ? worst.name : '' }));
      kpiHost.appendChild(ui.stat({ label: 'Экзаменационные', value: exams.length, hint: exams.slice(0, 3).map(function (row) { return row.name; }).join(', ') }));
    }

    function load() {
      var child = ctx.student && ctx.student();
      if (!child) {
        table.setError('Не выбран ученик');
        return Promise.resolve();
      }
      renderControls();
      table.setLoading(true);
      return platform.subjects({ studentId: child.id, date: state.date }).then(function (result) {
        state.rows = result.subjects || [];
        state.error = null;
        table.setRows(state.rows);
        renderKpis();
        return state.rows;
      }).catch(function (error) {
        state.error = error.message || String(error);
        table.setError(state.error);
        ui.toast('Предметы не загрузились', { type: 'error', detail: state.error });
      });
    }

    return {
      el: rootEl,
      show: function () { return load(); },
      hide: function () { },
      refresh: function () { return load(); },
      getDate: function () { return state.date; }
    };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.views = root.MeshUI.views || {};
  root.MeshUI.views.subjects = {
    id: 'subjects',
    title: 'Предметы',
    icon: 'book',
    hint: 'Средний балл и место по каждому предмету',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
