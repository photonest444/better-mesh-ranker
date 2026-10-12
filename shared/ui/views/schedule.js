/*!
 * Mesh Ranker — вкладка «Расписание» (день и неделя).
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var format = ui.format;
  var util = ui.util;
  var stats = ui.stats;
  var platform = root.MeshPlatform;

  var WEEKDAYS = [0, 1, 2, 3, 4]; // пн–пт

  function create(ctx) {
    var state = { date: util.todayIso(), lessons: [], weekMode: false, week: {}, loading: false };

    var controlsHost = h('div', { class: 'view-controls' });
    var kpiHost = h('div', { class: 'kpi-row' });
    var dayHost = h('div', {});
    var weekHost = h('div', { class: 'week-grid' });
    var rootEl = h('div', { class: 'view view-schedule' }, [controlsHost, kpiHost, dayHost, weekHost]);

    var table = ui.DataTable(dayHost, {
      columns: [
        { key: 'number', title: '№', type: 'number', width: '56px', align: 'center' },
        {
          key: 'time', title: 'Время', width: '120px', sortable: false,
          render: function (row) { return h('span', { class: 'time', text: (row.begin || '—') + (row.end ? '–' + row.end : '') }); }
        },
        { key: 'subject', title: 'Предмет' },
        { key: 'teacher', title: 'Учитель' },
        { key: 'room', title: 'Кабинет', width: '110px' },
        {
          key: 'mark', title: 'Оценка', type: 'number', width: '90px', align: 'center',
          render: function (row) { return row.mark === null || row.mark === undefined ? h('span', { class: 'muted', text: '—' }) : h('span', { class: 'mark mark-' + stats.gradeColor(row.mark), text: row.mark }); }
        },
        {
          key: 'homework', title: 'Задание',
          render: function (row) { return row.homework ? h('span', { class: 'hw-text', text: format.truncate(row.homework, 70) }) : h('span', { class: 'muted', text: '—' }); }
        }
      ],
      rows: [],
      pageSize: 0,
      sort: { key: 'number', dir: 'asc', type: 'number' },
      search: { enabled: true, placeholder: 'Поиск по предмету или учителю…' },
      exportTitle: 'Расписание',
      exportName: 'schedule',
      exportDate: state.date,
      empty: { title: 'Уроков нет', text: 'Выходной, каникулы или расписание ещё не опубликовано.' }
    });

    function renderControls() {
      ui.clear(controlsHost);
      controlsHost.appendChild(h('div', { class: 'controls-row' }, [
        h('div', { class: 'controls-group' }, [
          ui.button({ label: '‹ пред. день', kind: 'ghost', onClick: function () { shift(-1); } }),
          h('input', { class: 'input input-date', type: 'date', value: state.date, onchange: function (e) { state.date = e.target.value; load(); } }),
          ui.button({ label: 'след. день ›', kind: 'ghost', onClick: function () { shift(1); } }),
          ui.button({ label: 'Сегодня', kind: 'ghost', onClick: function () { state.date = util.todayIso(); load(); } })
        ]),
        h('div', { class: 'controls-group' }, [
          ui.button({
            label: state.weekMode ? 'Только день' : 'Показать неделю',
            kind: state.weekMode ? 'primary' : 'ghost',
            icon: 'table',
            onClick: function () { state.weekMode = !state.weekMode; load(); }
          }),
          ui.button({ label: 'Обновить', kind: 'ghost', icon: 'refresh', onClick: function () { load(); } })
        ])
      ]));
    }

    function shift(days) {
      state.date = util.addDays(state.date, days);
      load();
    }

    function renderKpis() {
      ui.clear(kpiHost);
      var lessons = state.lessons;
      var first = lessons[0];
      var last = lessons[lessons.length - 1];
      var cancelled = lessons.filter(function (lesson) { return lesson.isCancelled; });
      var withHomework = lessons.filter(function (lesson) { return lesson.homework; }).length;
      kpiHost.appendChild(ui.stat({
        label: 'Дата',
        value: format.dateShort(state.date),
        hint: format.dateRu(state.date, { weekday: true })
      }));
      kpiHost.appendChild(ui.stat({ label: 'Уроков', value: lessons.length, hint: 'с заданием: ' + withHomework }));
      kpiHost.appendChild(ui.stat({ label: 'Начало', value: first && first.begin ? first.begin : '—', hint: first ? first.subject : 'уроков нет' }));
      kpiHost.appendChild(ui.stat({ label: 'Конец', value: last && last.end ? last.end : '—', hint: last ? last.subject : 'уроков нет' }));
      kpiHost.appendChild(ui.stat({ label: 'Отменено', value: cancelled.length, color: cancelled.length ? 'red' : 'default' }));
    }

    function renderWeek() {
      ui.clear(weekHost);
      if (!state.weekMode) return;
      var weekStart = util.addDays(state.date, -((util.parseIso(state.date).getDay() + 6) % 7));
      WEEKDAYS.forEach(function (offset) {
        var iso = util.addDays(weekStart, offset);
        var lessons = state.week[iso];
        weekHost.appendChild(h('div', { class: 'week-col' + (iso === state.date ? ' week-col-active' : '') }, [
          h('div', { class: 'week-head' }, [
            h('b', { text: format.weekdayShort(iso) }),
            h('span', { class: 'muted small', text: ' ' + format.dateDayMonth(iso) })
          ]),
          lessons === undefined
            ? h('div', { class: 'week-loading', text: '…' })
            : lessons.length
              ? h('ol', { class: 'week-list' }, lessons.map(function (lesson) {
                return h('li', { class: 'week-item' + (lesson.isCancelled ? ' week-item-cancelled' : ''), onclick: function () { state.date = iso; state.weekMode = false; load(); } }, [
                  h('span', { class: 'week-time', text: lesson.begin || '—' }),
                  h('span', { class: 'week-subject', text: lesson.subject }),
                  lesson.room ? h('span', { class: 'week-room muted', text: lesson.room }) : null,
                  lesson.mark ? h('span', { class: 'mark mark-' + stats.gradeColor(lesson.mark), text: lesson.mark }) : null
                ]);
              }))
              : h('div', { class: 'week-empty muted small', text: 'нет уроков' })
        ]));
      });
    }

    function load() {
      var child = ctx.student && ctx.student();
      if (!child) return Promise.resolve();
      renderControls();
      renderWeek();
      table.setLoading(true);
      var dayPromise = platform.schedule({ studentId: child.id, date: state.date }).then(function (result) {
        state.lessons = result.lessons || [];
        table.setRows(state.lessons);
        renderKpis();
      });

      var weekPromise = Promise.resolve();
      if (state.weekMode) {
        state.week = {};
        var weekStart = util.addDays(state.date, -((util.parseIso(state.date).getDay() + 6) % 7));
        weekPromise = Promise.all(WEEKDAYS.map(function (offset) {
          var iso = util.addDays(weekStart, offset);
          return platform.schedule({ studentId: child.id, date: iso }).then(function (result) {
            state.week[iso] = result.lessons || [];
          }).catch(function () { state.week[iso] = []; });
        })).then(renderWeek);
      }

      return Promise.all([dayPromise, weekPromise]).catch(function (error) {
        table.setError(error.message || String(error));
        ui.toast('Расписание не загрузилось', { type: 'error', detail: error.message });
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
  root.MeshUI.views.schedule = {
    id: 'schedule',
    title: 'Расписание',
    icon: 'clock',
    hint: 'Уроки на день и на неделю',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
