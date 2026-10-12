/*!
 * Mesh Ranker — вкладка «Рейтинг».
 *
 * Возможности:
 *   • общий рейтинг и рейтинг по любому набору предметов (мультивыбор чипами, как в CLI);
 *   • таблицы по каждому предмету: место, Δ места, средний балл, Δ балла, полоса, статус;
 *   • KPI-плитки: моё место, мой средний балл, отрыв от лидера и от «следующего»;
 *   • сводная таблица сравнения предметов;
 *   • гистограмма распределения средних баллов класса;
 *   • переключение даты (снимок рейтинга на дату), экспорт в CSV, печать.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var stats = ui.stats;
  var format = ui.format;
  var util = ui.util;
  var platform = root.MeshPlatform;

  function subjectKey(subjectId) { return subjectId ? String(subjectId) : 'all'; }

  function create(context) {
    var ctx = context;
    var state = {
      date: root.MeshApp ? root.MeshApp.date : util.todayIso(),
      subjects: [],
      selected: ['all'],
      boards: {},
      loading: false,
      error: null,
      onlyMyClass: platform.settings.get().onlyMyClass !== false
    };

    var controlsHost = h('div', { class: 'view-controls' });
    var kpiHost = h('div', { class: 'kpi-row' });
    var summaryHost = h('div', { class: 'view-section' });
    var boardsHost = h('div', { class: 'view-section' });
    var rootEl = h('div', { class: 'view view-ranking' }, [controlsHost, kpiHost, summaryHost, boardsHost]);

    function student() {
      return ctx.student ? ctx.student() : null;
    }

    function personId() {
      var child = student();
      return child ? child.personId : null;
    }

    function studentId() {
      var child = student();
      return child ? child.id : null;
    }

    function renderControls() {
      ui.clear(controlsHost);

      var chips = ui.chips({
        multiple: true,
        selected: state.selected,
        options: [{ value: 'all', label: 'Общий рейтинг', color: 'blue' }].concat(state.subjects.map(function (subject) {
          return {
            value: subject.id,
            label: subject.name,
            hint: subject.average === null || subject.average === undefined ? null : format.markShort(subject.average),
            color: stats.gradeColor(subject.average),
            title: 'Средний балл: ' + format.markShort(subject.average) + (subject.place ? ', место: ' + subject.place : '')
          };
        })),
        onChange: function (values) {
          state.selected = values.length ? values : ['all'];
          load();
        }
      });

      var dateInput = h('input', {
        class: 'input input-date',
        type: 'date',
        value: state.date,
        onchange: function (event) { state.date = event.target.value || util.todayIso(); load(); }
      });

      var presets = [
        { label: 'Сегодня', value: util.todayIso() },
        { label: '−7 дней', value: util.addDays(util.todayIso(), -7) },
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
          h('span', { class: 'controls-label', text: 'Предметы' }),
          chips.el
        ])
      ]));
      controlsHost.appendChild(h('div', { class: 'controls-row' }, [
        h('div', { class: 'controls-group' }, [
          h('span', { class: 'controls-label', text: 'Снимок на дату' }),
          dateInput
        ]),
        h('div', { class: 'controls-group' }, presets),
        h('div', { class: 'controls-group controls-right' }, [
          ui.field({
            type: 'checkbox',
            label: 'Только мой класс',
            value: state.onlyMyClass,
            onChange: function (value) {
              state.onlyMyClass = value;
              platform.settings.set({ onlyMyClass: value });
              if (state.onlyMyClass) load(); else render();
            }
          }),
          ui.button({ label: 'Обновить', kind: 'ghost', icon: 'refresh', onClick: function () { load(true); } }),
          ui.button({ label: 'Печать', kind: 'ghost', icon: 'print', onClick: function () { window.print(); } })
        ])
      ]));
    }

    function renderKpis() {
      ui.clear(kpiHost);
      var primary = state.boards[subjectKey(state.selected[0])];
      if (!primary || !primary.summary) return;
      var summary = primary.summary;
      var mine = summary.myRow;
      kpiHost.appendChild(ui.stat({
        label: 'Моё место',
        value: summary.myPlace ? '#' + summary.myPlace : '—',
        unit: summary.total ? ' из ' + summary.total : '',
        color: stats.placeColor(summary.myPlace, summary.total),
        trend: mine ? mine.placeDelta === null ? null : (mine.placeDelta > 0 ? 1 : mine.placeDelta < 0 ? -1 : 0) : null,
        hint: mine && mine.previousPlace ? 'было #' + mine.previousPlace : 'предыдущий период неизвестен'
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Мой средний балл',
        value: format.markShort(summary.myAverage),
        color: stats.gradeColor(summary.myAverage),
        trend: mine ? stats.trendDirection(mine.average, mine.previousAverage) : null,
        hint: mine && mine.averageDelta !== null && mine.averageDelta !== undefined ? 'Δ ' + format.delta(mine.average, mine.previousAverage) : 'оценок пока нет'
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Средний по классу',
        value: format.markShort(summary.classAverage),
        color: stats.gradeColor(summary.classAverage),
        hint: 'медиана ' + format.markShort(summary.classMedian) + ', мин ' + format.markShort(summary.classMin) + ' / макс ' + format.markShort(summary.classMax)
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Лидер класса',
        value: summary.leader ? format.markShort(summary.leader.average) : '—',
        hint: summary.leader ? summary.leader.name : 'нет данных'
      }));
      kpiHost.appendChild(ui.stat({
        label: 'До лидера',
        value: summary.gapToLeader === null ? '—' : format.markShort(summary.gapToLeader),
        color: summary.gapToLeader === null ? 'default' : summary.gapToLeader <= 0 ? 'green' : summary.gapToLeader < 0.3 ? 'yellow' : 'orange',
        hint: summary.gapToLeader === 0 ? 'вы лидер класса' : 'столько баллов отделяет от первого места'
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Впереди / позади',
        value: (summary.aheadOfMe === null ? '—' : summary.aheadOfMe) + ' / ' + (summary.behindMe === null ? '—' : summary.behindMe),
        hint: summary.gapToNext === null ? 'сосед по рейтингу неизвестен' : 'до соседа сверху: ' + format.markShort(summary.gapToNext)
      }));
    }

    function exportColumns() {
      return [
        { key: 'place', title: 'Место', value: function (row) { return row.place; } },
        { key: 'placeDelta', title: 'Δ места', value: function (row) { return row.placeDelta === null ? '' : row.placeDelta; } },
        { key: 'name', title: 'Ученик', value: function (row) { return row.name; } },
        { key: 'average', title: 'Средний балл', value: function (row) { return row.average === null ? '' : String(row.average).replace('.', ','); } },
        { key: 'previousAverage', title: 'Предыдущий балл', value: function (row) { return row.previousAverage === null ? '' : String(row.previousAverage).replace('.', ','); } },
        { key: 'averageDelta', title: 'Δ балла', value: function (row) { return row.averageDelta === null ? '' : String(row.averageDelta).replace('.', ','); } },
        { key: 'status', title: 'Статус', value: function (row) { return row.status; } }
      ];
    }

    function renderBoard(subjectId, board) {
      var columns = [
        {
          key: 'place', title: '№', type: 'number', width: '64px', align: 'center',
          render: function (row) {
            return h('span', { class: 'place place-' + stats.placeColor(row.place, board.rows.length) }, [
              h('span', { text: row.place === null ? '—' : row.place }),
              row.placeDelta ? h('span', {
                class: 'place-delta ' + (row.placeDelta > 0 ? 'up' : 'down'),
                text: row.placeDelta > 0 ? '▲' + row.placeDelta : '▼' + Math.abs(row.placeDelta)
              }) : null
            ]);
          }
        },
        {
          key: 'name', title: 'Ученик',
          render: function (row) {
            return h('span', { class: 'student-cell' }, [
              row.isMe ? ui.badge('я', 'blue') : null,
              h('span', { class: row.isMe ? 'student-me' : '', text: row.name })
            ]);
          }
        },
        {
          key: 'average', title: 'Средний балл', type: 'number', summary: true,
          render: function (row) {
            return h('span', { class: 'mark mark-' + stats.gradeColor(row.average) }, format.markShort(row.average));
          }
        },
        {
          key: 'previousAverage', title: 'Было', type: 'number',
          render: function (row) { return h('span', { class: 'muted', text: format.markShort(row.previousAverage) }); }
        },
        {
          key: 'averageDelta', title: 'Δ', type: 'number',
          render: function (row) {
            if (row.averageDelta === null || row.averageDelta === undefined) return h('span', { class: 'muted', text: '—' });
            var cls = row.averageDelta > 0.004 ? 'delta-up' : row.averageDelta < -0.004 ? 'delta-down' : 'delta-same';
            return h('span', { class: 'delta ' + cls, text: format.delta(row.average, row.previousAverage) });
          }
        },
        {
          key: 'bar', title: 'Уровень', sortable: false,
          render: function (row) { return ui.bar(row.average, 5, { color: stats.gradeColor(row.average) }); }
        },
        {
          key: 'status', title: 'Статус',
          render: function (row) {
            var label = row.status === 'TOP' ? 'сильный' : row.status === 'MIDDLE' ? 'средний' : row.status || '—';
            var kind = row.status === 'TOP' ? 'green' : row.status === 'MIDDLE' ? 'default' : 'orange';
            return ui.badge(label, kind);
          }
        }
      ];

      var tableHost = h('div', {});
      var title = subjectId === 'all' ? 'Общий рейтинг' : board.subjectName || ('Предмет ' + subjectId);
      var card = ui.card({
        className: 'board-card',
        title: title,
        subtitle: 'на ' + format.dateRu(board.date) + ' · ' + format.studentsCount(board.rows.length) +
          ' · средний балл класса ' + format.markShort(board.summary.classAverage),
        body: tableHost
      });
      ui.DataTable(tableHost, {
        columns: columns,
        rows: board.rows,
        pageSize: platform.settings.get().pageSize || 25,
        sort: { key: 'place', dir: 'asc', type: 'number' },
        highlight: function (row) { return row.isMe; },
        search: { enabled: true, placeholder: 'Поиск ученика…' },
        exportTitle: 'Рейтинг: ' + title + ' на ' + format.dateShort(board.date),
        exportName: 'rating-' + util.slugify(title),
        exportDate: board.date,
        onRowClick: function (row) { openStudentModal(row, board, title); }
      });
      var headerExtra = [];
      if (platform.settings.get().showHistogram && board.summary.histogram) {
        headerExtra.push(renderHistogram(board.summary.histogram));
      }
      var body = h('div', {}, [headerExtra.length ? h('div', { class: 'board-extra' }, headerExtra) : null, card]);
      return body;
    }

    function renderHistogram(buckets) {
      var max = buckets.reduce(function (acc, bucket) { return Math.max(acc, bucket.count); }, 1);
      return h('div', { class: 'histogram' }, [
        h('div', { class: 'histogram-title muted small', text: 'Распределение средних баллов класса' }),
        h('div', { class: 'histogram-bars' }, buckets.map(function (bucket) {
          return h('div', {
            class: 'histogram-bar',
            title: bucket.label + ': ' + format.studentsCount(bucket.count)
          }, [
            h('div', { class: 'histogram-fill bar-' + stats.gradeColor(bucket.from), style: { height: Math.round((bucket.count / max) * 100) + '%' } }),
            h('span', { class: 'histogram-count', text: bucket.count || '' })
          ]);
        })),
        h('div', { class: 'histogram-labels' }, buckets.map(function (bucket) {
          return h('span', { text: bucket.label.slice(0, 3) });
        }))
      ]);
    }

    function renderComparison() {
      var keys = state.selected.map(subjectKey);
      if (keys.length < 2) return null;
      var rows = keys.map(function (key) {
        var board = state.boards[key];
        if (!board) return null;
        var subject = state.subjects.filter(function (item) { return String(item.id) === String(key); })[0];
        return {
          subjectId: key,
          subjectName: key === 'all' ? 'Общий рейтинг' : (board.subjectName || (subject ? subject.name : key)),
          place: board.summary.myPlace,
          total: board.summary.total,
          myAverage: board.summary.myAverage,
          classAverage: board.summary.classAverage,
          gapToLeader: board.summary.gapToLeader,
          myDelta: board.summary.myDelta,
          leader: board.summary.leader ? board.summary.leader.name : null,
          color: stats.gradeColor(board.summary.myAverage)
        };
      }).filter(Boolean);

      var columns = [
        { key: 'subjectName', title: 'Предмет' },
        { key: 'place', title: 'Моё место', type: 'number', render: function (row) { return row.place ? '#' + row.place : '—'; } },
        { key: 'total', title: 'В классе', type: 'number' },
        { key: 'myAverage', title: 'Мой балл', type: 'number', summary: true, render: function (row) { return h('span', { class: 'mark mark-' + row.color, text: format.markShort(row.myAverage) }); } },
        { key: 'classAverage', title: 'Класс', type: 'number', render: function (row) { return format.markShort(row.classAverage); } },
        { key: 'diff', title: 'К классу', type: 'number', render: function (row) { return format.delta(row.myAverage, row.classAverage); } },
        { key: 'gapToLeader', title: 'До лидера', type: 'number', render: function (row) { return row.gapToLeader === null ? '—' : format.markShort(row.gapToLeader); } },
        { key: 'myDelta', title: 'Δ за период', type: 'number', render: function (row) { return row.myDelta === null || row.myDelta === undefined ? '—' : format.markShort(row.myDelta); } },
        { key: 'bar', title: 'Уровень', sortable: false, render: function (row) { return ui.bar(row.myAverage, 5, { color: row.color }); } }
      ];

      var tableHost = h('div', {});
      var card = ui.card({
        title: 'Сравнение предметов',
        subtitle: 'Выбрано ' + rows.length + ' ' + format.pluralRu(rows.length, 'позиция', 'позиции', 'позиций'),
        body: tableHost,
        actions: [ui.button({
          label: 'Закрыть сравнение',
          kind: 'ghost',
          icon: 'close',
          onClick: function () { state.selected = [state.selected[0]]; render(); load(); }
        })]
      });
      ui.DataTable(tableHost, {
        columns: columns,
        rows: rows,
        pageSize: 0,
        showSummary: true,
        sort: { key: 'place', dir: 'asc', type: 'number' },
        search: { enabled: false },
        exportTitle: 'Сравнение предметов на ' + format.dateShort(state.date),
        exportName: 'subjects-comparison'
      });
      return card;
    }

    function openStudentModal(row, board, title) {
      var summary = board.summary;
      var rowsSiblings = board.rows.filter(function (item) { return Math.abs((item.place || 0) - (row.place || 0)) <= 2 && item.personId !== row.personId; });
      ui.modal({
        title: row.name,
        subtitle: title + ' · снимок на ' + format.dateRu(board.date),
        body: [
          h('div', { class: 'modal-stats' }, [
            ui.stat({ label: 'Место', value: row.place ? '#' + row.place : '—', unit: ' из ' + summary.total, color: stats.placeColor(row.place, summary.total) }),
            ui.stat({ label: 'Средний балл', value: format.markShort(row.average), color: stats.gradeColor(row.average) }),
            ui.stat({ label: 'Предыдущий', value: format.markShort(row.previousAverage) }),
            ui.stat({ label: 'Δ балла', value: row.averageDelta === null ? '—' : format.delta(row.average, row.previousAverage) })
          ]),
          h('div', { class: 'modal-block' }, [
            h('div', { class: 'muted small', text: 'Ближайшие соседи по рейтингу' }),
            h('ul', { class: 'list' }, rowsSiblings.length ? rowsSiblings.map(function (item) {
              return h('li', {}, [h('b', { text: '#' + item.place + ' ' }), h('span', { text: item.name + ' — ' + format.markShort(item.average) })]);
            }) : [h('li', { class: 'muted', text: 'совсем рядом никого нет' })])
          ]),
          h('div', { class: 'modal-block' }, [
            h('div', { class: 'muted small', text: 'Полоса относительно максимума класса (' + format.markShort(summary.classMax) + ')' }),
            ui.bar(row.average, 5, { color: stats.gradeColor(row.average) })
          ])
        ],
        actions: [{ label: 'Закрыть', kind: 'ghost' }]
      });
    }

    function render() {
      renderControls();
      renderKpis();
      ui.clear(summaryHost);
      ui.clear(boardsHost);

      if (state.error) {
        boardsHost.appendChild(ui.empty({ title: 'Не удалось загрузить рейтинг', text: state.error, icon: ui.icon('warn') }));
        return;
      }
      if (state.loading && !Object.keys(state.boards).length) {
        boardsHost.appendChild(ui.card({ body: ui.skeleton(8, 6) }));
        return;
      }

      var comparison = renderComparison();
      if (comparison) summaryHost.appendChild(comparison);

      state.selected.forEach(function (subjectId) {
        var key = subjectKey(subjectId);
        var board = state.boards[key];
        if (!board) {
          boardsHost.appendChild(ui.card({ title: subjectId === 'all' ? 'Общий рейтинг' : subjectId, body: ui.skeleton(6, 6) }));
          return;
        }
        boardsHost.appendChild(renderBoard(key, board));
      });
    }

    function load(force) {
      var child = student();
      if (!child) {
        state.error = 'Не выбран ученик — обновите профиль или войдите заново.';
        render();
        return Promise.resolve();
      }
      state.loading = true;
      state.error = null;
      render();

      var subjectsPromise = state.subjects.length && !force
        ? Promise.resolve({ subjects: state.subjects })
        : platform.subjects({ studentId: child.id, date: state.date }).then(function (result) {
          state.subjects = result.subjects || [];
          return result;
        });

      return subjectsPromise.then(function () {
        var requests = state.selected.map(function (subjectId) {
          var key = subjectKey(subjectId);
          var subject = state.subjects.filter(function (item) { return String(item.id) === String(subjectId); })[0];
          return platform.rank({
            studentId: child.id,
            personId: child.personId,
            date: state.date,
            subjectId: subjectId === 'all' ? null : subjectId,
            subjectName: subject ? subject.name : null
          }).then(function (board) {
            state.boards[key] = board;
          });
        });
        return Promise.all(requests);
      }).catch(function (error) {
        state.error = error.message || String(error);
        ui.toast('Рейтинг не загрузился', { type: 'error', detail: state.error });
      }).then(function () {
        state.loading = false;
        render();
      });
    }

    return {
      el: rootEl,
      show: function () { return load(); },
      hide: function () { },
      refresh: function () { return load(true); },
      setDate: function (iso) { state.date = iso; return load(true); },
      getDate: function () { return state.date; },
      reloadSubjects: function () { state.subjects = []; }
    };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.views = root.MeshUI.views || {};
  root.MeshUI.views.ranking = {
    id: 'ranking',
    title: 'Рейтинг',
    icon: 'chart',
    hint: 'Общий рейтинг класса и рейтинг по предметам',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
