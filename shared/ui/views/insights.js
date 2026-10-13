/*!
 * Mesh Ranker — вкладка «Прогноз и динамика».
 *
 * Что здесь есть (всё это считает общее ядро — JS или Rust, смотря что рядом):
 *   • прогноз до цели: какой средний балл нужен и сколько «пятёрок» осталось;
 *   • «а что если»: как изменится средний балл от новых оценок;
 *   • влияние: по каким предметам одна «пятёрка» даст наибольший прирост;
 *   • дедлайны: раскладка заданий по срокам и нагрузка на ближайшие две недели;
 *   • динамика: снимки места и балла, спарклайн, дельты, экспорт и импорт.
 *
 * Внизу вкладки видно, какой движок считал (Rust или JS) и сколько вызовов
 * ушло в нативное ядро — это и есть «оптимизация на расте» в интерфейсе.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var util = ui.util;
  var format = ui.format;
  var platform = root.MeshPlatform;
  var lib = root.MeshLib;
  var insights = lib.insights;
  var accelerate = lib.accelerate;

  var PERIODS = [
    { label: '30 дней', days: 30 },
    { label: 'Четверть', days: 60 },
    { label: 'Полугодие', days: 120 },
    { label: 'Учебный год', schoolYear: true }
  ];

  /** Знаковая запись одного числа: +0.25 / -1 / — . */
  function deltaText(value, digits) {
    if (value === null || value === undefined || value !== value) return '—';
    var number = Number(value);
    return (number > 0 ? '+' : '') + number.toFixed(digits === undefined ? 2 : digits);
  }

  function create(context) {
    var ctx = context;
    var settings = platform.settings.get();
    var state = {
      from: util.addDays(util.todayIso(), -60),
      to: util.todayIso(),
      date: root.MeshApp ? root.MeshApp.date : util.todayIso(),
      subjects: [],
      subjectId: null,
      target: util.asNum(settings.insightsTarget, 4.5) || 4.5,
      remaining: util.asInt(settings.insightsRemaining, 3) || 3,
      marks: [],
      summary: null,
      board: null,
      homeworks: [],
      forecast: null,
      impact: [],
      series: null,
      deadlineReport: null,
      whatIf: null,
      extra: '',
      loading: false,
      engineNote: null
    };
    // Движок для «горячих» расчётов: Rust, если рядом есть собранный mesh-rank.
    var accelerator = accelerate.isNative() ? null : accelerate.createAccelerator({});
    if (accelerator) accelerate.attach(accelerator);
    var history = insights.createHistoryStore({ key: 'mesh.insights.history.v1' });

    var controlsHost = h('div', { class: 'view-controls' });
    var kpiHost = h('div', { class: 'kpi-row' });
    var whatIfHost = h('div', { class: 'view-section' });
    var impactHost = h('div', { class: 'view-section' });
    var deadlineHost = h('div', { class: 'view-section' });
    var historyHost = h('div', { class: 'view-section' });
    var engineHost = h('div', { class: 'view-footer-notes muted small' });

    var rootEl = h('div', { class: 'view view-insights' }, [
      controlsHost,
      kpiHost,
      whatIfHost,
      impactHost,
      deadlineHost,
      historyHost,
      engineHost
    ]);

    function student() {
      return ctx.student ? ctx.student() : null;
    }

    function studentKey() {
      var child = student();
      return (child && (child.id || child.personId)) || 'me';
    }

    function local(key, fallback) {
      return function () { return fallback(); };
    }

    // ------------------------------------------------------------- загрузка ---

    function load() {
      var child = student();
      if (!child) return Promise.resolve();
      state.loading = true;
      renderControls();

      var subjectsPromise = state.subjects.length
        ? Promise.resolve()
        : platform.subjects({ studentId: child.id, date: state.date }).then(function (result) {
          state.subjects = (result && result.subjects) || [];
          renderControls();
        }).catch(function () { state.subjects = []; });

      var homeworkFrom = util.addDays(util.todayIso(), -14);
      var homeworkTo = util.addDays(util.todayIso(), 14);

      return subjectsPromise.then(function () {
        return Promise.all([
          platform.marks({ studentId: child.id, from: state.from, to: state.to }),
          platform.rank({ studentId: child.id, date: state.date, subjectId: state.subjectId }).catch(function (error) {
            state.error = error.message;
            return null;
          }),
          platform.homeworks({ studentId: child.id, from: homeworkFrom, to: homeworkTo }).catch(function () {
            return { homeworks: [] };
          })
        ]);
      }).then(function (results) {
        var marksResult = results[0] || {};
        var boardResult = results[1];
        var homeworkResult = results[2] || {};

        state.marks = marksResult.marks || [];
        state.summary = marksResult.summary || null;
        state.board = boardResult;
        state.homeworks = homeworkResult.homeworks || [];
        state.series = insights.historySeries(history.all(studentKey()), state.subjectId ? String(state.subjectId) : null);

        return computeAll();
      }).then(function () {
        state.loading = false;
        renderAll();
      }).catch(function (error) {
        state.loading = false;
        renderAll();
        ui.toast('Аналитика не загрузилась', { type: 'error', detail: error.message });
      });
    }

    /** Прогноз, влияние и дедлайны: считает Rust, если он рядом, иначе JS. */
    function computeAll() {
      var reference = util.todayIso();
      var target = state.target;
      var remaining = state.remaining;

      return Promise.all([
        accelerate.forecast(state.marks, target, remaining, local('forecast', function () {
          return insights.forecast(state.marks, target, remaining);
        })),
        accelerate.impact(state.marks, 8, local('impact', function () {
          return insights.subjectImpact(state.marks, 8);
        })),
        accelerate.deadlines(state.homeworks, reference, local('deadlines', function () {
          return insights.deadlines(state.homeworks, reference);
        }))
      ]).then(function (results) {
        state.forecast = results[0].value;
        state.impact = results[1].value || [];
        state.deadlineReport = results[2].value;
        var engines = results.map(function (item) { return item.engine; });
        state.engineNote = {
          engines: engines,
          native: engines.filter(function (name) { return name === 'rust'; }).length,
          fallback: results.some(function (item) { return item.fallback; })
        };
        state.whatIf = insights.whatIf(state.marks, parseExtra(state.extra));
      });
    }

    function parseExtra(text) {
      return util.asStr(text).split(/[^0-9.]+/).map(function (part) {
        return util.asNum(part, null);
      }).filter(function (value) {
        return value !== null && value >= 2 && value <= 5;
      });
    }

    // ------------------------------------------------------------- контролы ---

    function periodChips() {
      return ui.chips({
        options: PERIODS.map(function (period, index) {
          return { value: index, label: period.label };
        }),
        selected: ['1'],
        onChange: function (value) {
          var period = PERIODS[value];
          if (!period) return;
          state.from = period.schoolYear ? util.schoolYearStart(state.to) : util.addDays(state.to, -period.days);
          renderControls();
          load();
        }
      });
    }

    function subjectOptions() {
      var options = [{ value: '', label: 'Все предметы' }];
      state.subjects.forEach(function (subject) {
        options.push({ value: subject.id, label: subject.name });
      });
      return options;
    }

    function renderControls() {
      ui.clear(controlsHost);
      var targetInput = ui.field({
        label: 'Цель', type: 'number', value: state.target, min: 2, max: 5, step: 0.05,
        hint: 'Желаемый средний балл',
        onChange: function (value) {
          state.target = util.asNum(value, 4.5) || 4.5;
          platform.settings.set({ insightsTarget: state.target });
          computeAll().then(renderAll);
        }
      });
      var remainingInput = ui.field({
        label: 'Работ впереди', type: 'number', value: state.remaining, min: 0, max: 60, step: 1,
        hint: 'Сколько оценок ещё ждём',
        onChange: function (value) {
          state.remaining = Math.max(0, util.asInt(value, 3) || 0);
          platform.settings.set({ insightsRemaining: state.remaining });
          computeAll().then(renderAll);
        }
      });
      var subjectSelect = ui.field({
        label: 'Предмет', type: 'select', value: state.subjectId || '', options: subjectOptions(),
        onChange: function (value) {
          state.subjectId = value || null;
          state.series = insights.historySeries(history.all(studentKey()), state.subjectId ? String(state.subjectId) : null);
          renderAll();
        }
      });
      var fromInput = ui.field({
        label: 'С', type: 'date', value: state.from,
        onChange: function (value) { state.from = value || state.from; load(); }
      });
      var toInput = ui.field({
        label: 'По', type: 'date', value: state.to,
        onChange: function (value) { state.to = value || state.to; load(); }
      });

      controlsHost.appendChild(ui.toolbar([
        periodChips().el,
        h('div', { class: 'toolbar-group' }, [subjectSelect]),
        h('div', { class: 'toolbar-group' }, [targetInput, remainingInput]),
        h('div', { class: 'toolbar-group' }, [fromInput, toInput]),
        h('div', { class: 'toolbar-group' }, [
          ui.button({ label: 'Обновить', icon: 'refresh', kind: 'primary', onClick: load }),
          ui.button({ label: 'Снимок', icon: 'star', title: 'Сохранить текущий рейтинг в динамику', onClick: saveSnapshot }),
          ui.button({ label: 'CSV', icon: 'download', title: 'Выгрузить анализ в CSV', onClick: exportCsv })
        ])
      ]));
      if (state.loading) controlsHost.appendChild(ui.spinner('Считаем…'));
    }

    // ------------------------------------------------------------------ KPI ---

    function renderKpis() {
      ui.clear(kpiHost);
      var forecast = state.forecast || {};
      var summary = state.summary || {};
      var board = (state.board && state.board.summary) || {};
      var place = board.myPlace === undefined ? null : board.myPlace;
      var series = state.series || {};
      var deadline = state.deadlineReport || {};

      kpiHost.appendChild(ui.stat({
        label: 'Средний балл', value: format.markShort(summary.average),
        hint: format.marksCount(summary.withValue || 0) + ' за период',
        color: ui.stats.gradeColor(summary.average),
        trend: series.trend
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Взвешенный', value: format.markShort(summary.weightedAverage),
        hint: 'С учётом веса работ', color: ui.stats.gradeColor(summary.weightedAverage)
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Цель', value: format.markShort(state.target),
        unit: forecast.gap === undefined || forecast.gap === null ? '' : (forecast.gap > 0 ? ' +' + format.markShort(forecast.gap) : ' ✓'),
        hint: forecast.text || '', color: forecast.status === 'done' ? 'green' : forecast.status === 'achievable' ? 'yellow' : 'red'
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Нужно «пятёрок»', value: forecast.fivesNeeded === null || forecast.fivesNeeded === undefined ? '—' : forecast.fivesNeeded,
        hint: forecast.remaining ? 'за ' + forecast.remaining + ' ' + format.pluralRu(forecast.remaining, 'работу', 'работы', 'работ') : '',
        color: forecast.fivesNeeded === 0 ? 'green' : 'default'
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Максимум', value: format.markShort(forecast.maxPossible),
        hint: 'если дальше только «5»', color: ui.stats.gradeColor(forecast.maxPossible)
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Место в классе', value: place === null || place === undefined ? '—' : place,
        unit: board.total ? 'из ' + board.total : '',
        hint: series.placeDelta === null || series.placeDelta === undefined ? 'нет истории'
          : (series.placeDelta > 0 ? '↑ на ' + series.placeDelta + ' с прошлого снимка' : series.placeDelta < 0 ? '↓ на ' + Math.abs(series.placeDelta) : 'без изменений'),
        color: ui.stats.placeColor(place, board.total),
        trend: series.trend
      }));
      kpiHost.appendChild(ui.stat({
        label: 'Задания', value: deadline.undone === undefined ? '—' : deadline.undone,
        hint: deadline.overdue ? 'просрочено: ' + deadline.overdue : 'всё под контролем',
        color: deadline.overdue ? 'red' : deadline.undone ? 'yellow' : 'green'
      }));
    }

    // ------------------------------------------------------------ «что если» ---

    function renderWhatIf() {
      ui.clear(whatIfHost);
      var result = state.whatIf || {};
      var before = result.before;
      var after = result.after;

      var input = ui.field({
        label: 'Новые оценки', value: state.extra, placeholder: 'например 5 5 4',
        hint: 'Введите числа через пробел или запятую',
        onChange: function (value) {
          state.extra = value;
          var extra = parseExtra(value);
          if (!extra.length) {
            state.whatIf = insights.whatIf(state.marks, []);
            renderWhatIf();
            return;
          }
          accelerate.run('whatIf', { marks: state.marks, extra: extra }, function () {
            return insights.whatIf(state.marks, extra);
          }).then(function (computed) {
            state.whatIf = computed.value;
            renderWhatIf();
          });
        }
      });

      var quick = [5, 4, 3].map(function (value) {
        return ui.button({
          label: '+' + value, kind: 'ghost',
          title: 'Добавить одну оценку ' + value,
          onClick: function () {
            var extra = parseExtra(state.extra).concat([value]);
            state.extra = extra.join(' ');
            accelerate.run('whatIf', { marks: state.marks, extra: extra }, function () {
              return insights.whatIf(state.marks, extra);
            }).then(function (computed) {
              state.whatIf = computed.value;
              renderWhatIf();
            });
          }
        });
      });

      var preview = h('div', { class: 'what-if-preview' }, [
        ui.bar(before === null || before === undefined ? 0 : before, 5, { color: ui.stats.gradeColor(before), title: 'Сейчас: ' + format.markShort(before) }),
        ui.bar(after === null || after === undefined ? 0 : after, 5, { color: ui.stats.gradeColor(after), title: 'Станет: ' + format.markShort(after) }),
        h('div', { class: 'muted small', text: before === null || before === undefined ? 'Оценок за период нет'
          : 'Сейчас ' + format.markShort(before) + ' → станет ' + format.markShort(after) + ' (' + deltaText(result.delta) + ')' })
      ]);

      whatIfHost.appendChild(ui.card({
        title: 'А что если?',
        subtitle: 'Прикидка: как новые оценки изменят средний балл',
        actions: quick,
        body: h('div', { class: 'what-if' }, [input, preview])
      }));
    }

    // -------------------------------------------------------------- влияние ---

    function renderImpact() {
      ui.clear(impactHost);
      var rows = (state.impact || []).map(function (row) {
        return {
          subjectId: row.subjectId,
          subjectName: row.subjectName,
          count: row.count,
          average: row.average,
          deltaIfFive: row.deltaIfFive,
          share: row.share,
          color: ui.stats.gradeColor(row.average)
        };
      });
      if (!rows.length) {
        impactHost.appendChild(ui.card({
          title: 'Где «пятёрка» поможет больше всего',
          body: ui.empty({ title: 'Оценок за период нет', text: 'Измените период — и увидите, какие предметы тянут балл вниз.' })
        }));
        return;
      }
      var table = ui.DataTable(impactHost, {
        columns: [
          { key: 'subjectName', title: 'Предмет' },
          { key: 'count', title: 'Оценок', type: 'number', width: '90px' },
          {
            key: 'average', title: 'Средний', type: 'number',
            render: function (row) { return h('span', { class: 'mark mark-' + row.color, text: format.markShort(row.average) }); }
          },
          {
            key: 'deltaIfFive', title: 'Прирост от «5»', type: 'number',
            render: function (row) { return h('span', { class: 'delta up', text: '+' + format.markShort(row.deltaIfFive) }); }
          },
          {
            key: 'bar', title: 'Прирост', sortable: false,
            render: function (row) { return ui.bar(row.deltaIfFive, 1, { color: 'green', label: false, title: '+' + format.markShort(row.deltaIfFive) }); }
          },
          {
            key: 'share', title: 'Доля оценок', type: 'number',
            render: function (row) { return h('span', { text: format.percent(row.share, 0) }); }
          }
        ],
        rows: rows,
        pageSize: 8,
        sort: { key: 'deltaIfFive', dir: 'desc', type: 'number' },
        exportTitle: 'Влияние оценок по предметам',
        exportName: 'impact',
        exportDate: util.todayIso()
      });
      var head = h('div', { class: 'card-head-inline' }, [
        h('h3', { text: 'Где «пятёрка» поможет больше всего' }),
        h('p', { class: 'muted small', text: 'Предметы отсортированы по приросту среднего балла от одной «пятёрки»' })
      ]);
      impactHost.insertBefore(head, table.el);
    }

    // ------------------------------------------------------------- дедлайны ---

    function renderDeadlines() {
      ui.clear(deadlineHost);
      var report = state.deadlineReport || { groups: [], byDay: [] };
      var groups = (report.groups || []).filter(function (group) { return group.count > 0; });
      var badges = groups.map(function (group) {
        var kind = group.key === 'overdue' ? 'red' : group.key === 'today' ? 'orange' : group.key === 'done' ? 'green' : 'default';
        return h('div', { class: 'deadline-chip' }, [
          ui.badge(group.count, kind, group.label),
          h('span', { class: 'muted small', text: group.label })
        ]);
      });

      var maxDay = 0;
      (report.byDay || []).forEach(function (day) { maxDay = Math.max(maxDay, day.count); });
      var load = h('div', { class: 'load-chart' }, (report.byDay || []).map(function (day) {
        var height = maxDay ? Math.round((day.count / maxDay) * 100) : 0;
        return h('div', {
          class: 'load-day' + (day.date === util.todayIso() ? ' load-today' : ''),
          title: format.dateShort(day.date) + ': ' + day.count + ' ' + format.pluralRu(day.count, 'задание', 'задания', 'заданий')
        }, [
          h('div', { class: 'load-column' }, [
            h('div', { class: 'load-fill' + (day.count >= 3 ? ' load-hard' : ''), style: { height: height + '%' } })
          ]),
          h('span', { class: 'load-label', text: format.dateShort(day.date).slice(0, 5) })
        ]);
      }));

      var upcoming = (report.groups || []).filter(function (group) {
        return group.key === 'overdue' || group.key === 'today' || group.key === 'tomorrow' || group.key === 'week';
      }).reduce(function (acc, group) {
        return acc.concat(group.items || []);
      }, []).slice(0, 5).map(function (item) {
        return h('li', {}, [
          h('span', { class: 'deadline-date', text: item.dueDate ? format.dateShort(item.dueDate) : 'без срока' }),
          h('span', { class: 'deadline-subject', text: item.subjectName || '—' }),
          h('span', { class: 'muted small', text: format.truncate(item.description || '', 70) })
        ]);
      });

      var body = h('div', { class: 'deadlines' }, [
        h('div', { class: 'deadline-summary' }, [
          h('div', { class: 'deadline-badges' }, badges.length ? badges : [h('span', { class: 'muted', text: 'Незакрытых заданий нет' })]),
          h('div', { class: 'muted small', text: report.total
            ? 'Выполнено ' + report.done + ' из ' + report.total + ' (' + format.percent(report.progress, 0) + ')'
            : 'Заданий за период не найдено' }),
          h('div', { class: 'progress' }, [h('div', { class: 'progress-fill', style: { width: Math.round((report.progress || 0) * 100) + '%' } })])
        ]),
        load,
        upcoming.length ? h('ul', { class: 'deadline-list' }, upcoming) : null
      ]);

      deadlineHost.appendChild(ui.card({
        title: 'Дедлайны и нагрузка',
        subtitle: 'Ближайшие две недели: сколько заданий сдавать каждый день',
        body: body
      }));
    }

    // ------------------------------------------------------------- динамика ---

    function renderHistory() {
      ui.clear(historyHost);
      var series = state.series || { points: [], count: 0 };
      var points = series.points || [];

      var head = h('div', { class: 'card-head-inline' }, [
        h('h3', { text: 'Динамика' }),
        h('p', { class: 'muted small', text: points.length
          ? 'Снимки: ' + format.dateShort(series.firstDate) + ' — ' + format.dateShort(series.lastDate)
          : 'Пока пусто — нажмите «Снимок», чтобы сохранить текущий рейтинг' }),
        h('div', { class: 'card-actions' }, [
          ui.button({ label: 'Снимок', icon: 'star', kind: 'primary', onClick: saveSnapshot }),
          ui.button({ label: 'Экспорт', icon: 'download', onClick: exportHistory }),
          ui.button({ label: 'Импорт', icon: 'upload', onClick: importHistory }),
          ui.button({ label: 'Очистить', icon: 'trash', kind: 'danger', onClick: clearHistory })
        ])
      ]);

      var body;
      if (!points.length) {
        body = h('div', {}, [
          head,
          ui.empty({
            title: 'История пуста', icon: 'info',
            text: 'Снимок сохраняет место и средний балл на дату — так видно, растёте вы или нет.',
            action: { label: 'Сохранить снимок', onClick: saveSnapshot }
          })
        ]);
      } else {
        var spark = h('div', { class: 'sparkline-block' }, [
          h('div', { class: 'sparkline-row' }, [
            h('span', { class: 'muted small', text: 'Балл' }),
            h('span', { class: 'sparkline', text: series.sparkline }),
            h('span', { class: 'delta ' + (series.averageDelta > 0 ? 'up' : series.averageDelta < 0 ? 'down' : 'same'), text: deltaText(series.averageDelta) })
          ]),
          h('div', { class: 'sparkline-row' }, [
            h('span', { class: 'muted small', text: 'Место' }),
            h('span', { class: 'sparkline', text: series.placeSparkline }),
            h('span', { class: 'delta ' + (series.placeDelta > 0 ? 'up' : series.placeDelta < 0 ? 'down' : 'same'), text: deltaText(series.placeDelta) })
          ])
        ]);

        var facts = h('div', { class: 'history-facts' }, [
          ui.stat({ label: 'Было', value: format.markShort(series.firstAverage), hint: series.firstPlace ? series.firstPlace + '-е место' : '', color: ui.stats.gradeColor(series.firstAverage) }),
          ui.stat({ label: 'Стало', value: format.markShort(series.lastAverage), hint: series.lastPlace ? series.lastPlace + '-е место' : '', color: ui.stats.gradeColor(series.lastAverage), trend: series.trend }),
          ui.stat({ label: 'Лучшее место', value: series.bestPlace === null ? '—' : series.bestPlace, hint: series.bestPlaceDate ? format.dateShort(series.bestPlaceDate) : '', color: 'green' })
        ]);

        var table = ui.DataTable(h('div', {}), {
          columns: [
            { key: 'date', title: 'Дата', type: 'date', width: '120px' },
            { key: 'place', title: 'Место', type: 'number', width: '80px' },
            { key: 'average', title: 'Средний', type: 'number', render: function (row) { return format.markShort(row.average); } },
            { key: 'classAverage', title: 'Класс', type: 'number', render: function (row) { return format.markShort(row.classAverage); } },
            {
              key: 'gap', title: 'Отрыв', type: 'number',
              value: function (row) { return row.average === null || row.classAverage === null ? null : row.average - row.classAverage; },
              render: function (row) {
                var gap = row.average === null || row.classAverage === null ? null : row.average - row.classAverage;
                return h('span', { class: 'delta ' + (gap > 0 ? 'up' : gap < 0 ? 'down' : 'same'), text: deltaText(gap) });
              }
            },
            {
              key: 'deltaPlace', title: 'Δ места', type: 'number',
              render: function (row, index) {
                var previous = points[index - 1];
                if (!previous || previous.place === null || row.place === null) return h('span', { class: 'muted', text: '—' });
                var delta = previous.place - row.place;
                return h('span', { class: 'delta ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'), text: deltaText(delta) });
              }
            }
          ],
          rows: points,
          pageSize: 10,
          sort: { key: 'date', dir: 'desc', type: 'date' },
          exportTitle: 'Динамика рейтинга',
          exportName: 'history',
          exportDate: util.todayIso()
        });

        body = h('div', {}, [head, spark, facts, table.el]);
      }

      historyHost.appendChild(ui.card({ body: body }));
    }

    // ------------------------------------------------------------ действия ---

    function saveSnapshot() {
      var child = student();
      if (!child) return Promise.resolve();
      var board = state.board;
      var promise = board ? Promise.resolve(board) : platform.rank({ studentId: child.id, date: state.date, subjectId: state.subjectId });
      return promise.then(function (result) {
        if (!result || !result.summary) {
          ui.toast('Нечего сохранять: рейтинг не загрузился', { type: 'warn' });
          return null;
        }
        var snapshot = insights.snapshotFromBoard(result);
        history.append(studentKey(), snapshot);
        state.series = insights.historySeries(history.all(studentKey()), state.subjectId ? String(state.subjectId) : null);
        renderAll();
        ui.toast('Снимок сохранён: ' + format.dateShort(snapshot.date) + ', ' + (snapshot.myPlace || '—') + '-е место', { type: 'success' });
        return snapshot;
      }).catch(function (error) {
        ui.toast('Не удалось сохранить снимок', { type: 'error', detail: error.message });
      });
    }

    function exportHistory() {
      var text = history.exportJson();
      var fileName = format.exportFileName('history', util.todayIso(), 'json');
      return ui.saveTextFile(fileName, text, 'application/json').then(function () {
        ui.toast('История выгружена: ' + fileName, { type: 'success' });
      });
    }

    function importHistory() {
      var area = h('textarea', { class: 'input modal-textarea', rows: 8, placeholder: '{"students":{…}}' });
      ui.modal({
        title: 'Импорт истории',
        subtitle: 'Вставьте содержимое файла mesh-history-*.json',
        body: area,
        actions: [
          { label: 'Отмена', kind: 'ghost' },
          {
            label: 'Импортировать', kind: 'primary',
            onClick: function () {
              var ok = history.importJson(area.value);
              if (!ok) {
                ui.toast('Не похоже на файл истории', { type: 'error' });
                return false;
              }
              state.series = insights.historySeries(history.all(studentKey()), state.subjectId ? String(state.subjectId) : null);
              renderAll();
              ui.toast('История импортирована', { type: 'success' });
              return true;
            }
          }
        ]
      });
    }

    function clearHistory() {
      ui.confirm('Удалить все сохранённые снимки этого ученика?').then(function (ok) {
        if (!ok) return;
        history.clear(studentKey());
        state.series = insights.historySeries([], null);
        renderAll();
        ui.toast('История очищена', { type: 'success' });
      });
    }

    function exportCsv() {
      var rows = (state.impact || []).map(function (row) {
        return {
          subject: row.subjectName,
          count: row.count,
          average: row.average,
          deltaIfFive: row.deltaIfFive,
          share: row.share
        };
      });
      var columns = [
        { key: 'subject', title: 'Предмет' },
        { key: 'count', title: 'Оценок' },
        { key: 'average', title: 'Средний балл' },
        { key: 'deltaIfFive', title: 'Прирост от «5»' },
        { key: 'share', title: 'Доля оценок' }
      ];
      var summaryLine = state.forecast
        ? 'Средний ' + format.markShort(state.summary && state.summary.average) + '; цель ' + format.markShort(state.target)
          + '; ' + state.forecast.text
        : '';
      var fileName = format.exportFileName('insights', util.todayIso(), 'csv');
      var csv = format.toCsv(rows, columns, summaryLine ? { title: summaryLine } : undefined);
      return ui.saveTextFile(fileName, csv, 'text/csv').then(function () {
        ui.toast('Файл сохранён: ' + fileName, { type: 'success' });
      });
    }

    // -------------------------------------------------------------- вывод ---

    function renderEngine() {
      var engine = accelerate.engine();
      var note = state.engineNote || {};
      var text;
      if (engine.available) {
        text = 'Движок: Rust ' + (engine.native && engine.native.version ? engine.native.version : '') +
          ' — нативных вызовов: ' + engine.nativeCalls +
          (engine.savedMs ? ', экономия ≈ ' + engine.savedMs + ' мс' : '') +
          (note.fallback ? ' (часть расчётов осталась на JS)' : '');
      } else {
        text = 'Движок: JavaScript' + (engine.native && engine.native.reason ? ' — ' + engine.native.reason : '');
      }
      engineHost.textContent = text;
    }

    function renderAll() {
      renderControls();
      renderKpis();
      renderWhatIf();
      renderImpact();
      renderDeadlines();
      renderHistory();
      renderEngine();
    }

    renderControls();

    return {
      el: rootEl,
      show: function () { return load(); },
      hide: function () { },
      refresh: function () { return load(); }
    };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.views = root.MeshUI.views || {};
  root.MeshUI.views.insights = {
    id: 'insights',
    title: 'Прогноз',
    icon: 'chart',
    hint: 'Прогноз до цели, дедлайны и динамика',
    create: create
  };
})(typeof self !== 'undefined' ? self : this);
