'use strict';
/*
 * Тесты аналитики (shared/core/lib/insights.js) и моста к нативному ядру
 * (shared/core/native.js). Проверяются те же поля, что отдаёт Rust-версия
 * (`rust/crates/mesh-core/src/insights.rs`), поэтому интерфейс не зависит от
 * выбранного движка.
 */

const test = require('node:test');
const assert = require('node:assert');

const util = require('../shared/core/lib/util.js');
const insights = require('../shared/core/lib/insights.js');
const native = require('../shared/core/native.js');

function marks(values) {
  return values.map((value, index) => ({
    id: 'm' + index,
    value: value,
    weight: 1,
    date: '2026-10-0' + ((index % 9) + 1),
    subjectId: 's1',
    subjectName: 'Математика'
  }));
}

test('sparkline: рисует мини-диаграмму и умеет инвертировать места', () => {
  const line = insights.sparkline([4.1, 4.3, 4.5]);
  assert.strictEqual(line.length, 3);
  assert.strictEqual(line[0], '▁');
  assert.strictEqual(line[2], '█');
  assert.strictEqual(insights.sparkline([]), '');
  assert.strictEqual(insights.sparkline([4.5]), '▄');
  // Для мест меньше — лучше: первое место должно быть самым высоким столбиком.
  const places = insights.sparkline([1, 5, 9], { invert: true });
  assert.ok(places.charCodeAt(0) > places.charCodeAt(2));
});

test('forecast: цель достижима, недостижима и уже достигнута', () => {
  const list = marks([5, 4, 3]); // средний 4.0
  const reachable = insights.forecast(list, 4.2, 1);
  assert.strictEqual(reachable.status, 'achievable');
  assert.strictEqual(reachable.fivesNeeded, 1);
  assert.strictEqual(reachable.neededAverage, 4.8);
  assert.strictEqual(reachable.average, 4);

  const hopeless = insights.forecast(list, 4.6, 1);
  assert.strictEqual(hopeless.status, 'unreachable');
  assert.strictEqual(hopeless.maxPossible, 4.25);
  assert.ok(/не достижима/.test(hopeless.text));

  const done = insights.forecast(marks([5, 5]), 4.5, 2);
  assert.strictEqual(done.status, 'done');
  assert.ok(/уже достигнута/.test(done.text));

  const empty = insights.forecast([], 4.5, 3);
  assert.strictEqual(empty.count, 0);
  assert.strictEqual(empty.status, 'achievable');
});

test('whatIf: считает средний балл до и после новых оценок', () => {
  const result = insights.whatIf(marks([4, 4]), [5]);
  assert.strictEqual(result.before, 4);
  assert.strictEqual(result.after, 4.33);
  assert.strictEqual(result.delta, 0.33);
  assert.deepStrictEqual(result.added, [5]);
});

test('subjectImpact: показывает, где «пятёрка» даст наибольший прирост', () => {
  const list = [
    { value: 5, subjectId: 's-math', subjectName: 'Математика' },
    { value: 5, subjectId: 's-math', subjectName: 'Математика' },
    { value: 3, subjectId: 's-phys', subjectName: 'Физика' },
    { value: 3, subjectId: 's-phys', subjectName: 'Физика' }
  ];
  const impact = insights.subjectImpact(list, 0);
  assert.strictEqual(impact.length, 2);
  assert.strictEqual(impact[0].subjectName, 'Физика');
  assert.strictEqual(impact[0].deltaIfFive, 0.67);
  assert.strictEqual(impact[1].deltaIfFive, 0);
  assert.strictEqual(impact[1].share, 0.5);
});

test('deadlines: раскладывает задания по срокам и считает нагрузку', () => {
  const homeworks = [
    { id: 'h1', subjectName: 'Русский', dueDate: '2026-10-11', isDone: false },
    { id: 'h2', subjectName: 'Физика', dueDate: '2026-10-13', isDone: false },
    { id: 'h3', subjectName: 'История', dueDate: '2026-10-14', isDone: false },
    { id: 'h4', subjectName: 'Английский', dueDate: '2026-10-16', isDone: false },
    { id: 'h5', subjectName: 'Биология', dueDate: '2026-10-25', isDone: false },
    { id: 'h6', subjectName: 'География', dueDate: null, isDone: false },
    { id: 'h7', subjectName: 'Алгебра', dueDate: '2026-10-12', isDone: true }
  ];
  const report = insights.deadlines(homeworks, '2026-10-13');
  const counts = {};
  report.groups.forEach((group) => { counts[group.key] = group.count; });
  assert.strictEqual(counts.overdue, 1);
  assert.strictEqual(counts.today, 1);
  assert.strictEqual(counts.tomorrow, 1);
  assert.strictEqual(counts.week, 1);
  assert.strictEqual(counts.later, 1);
  assert.strictEqual(counts['no-deadline'], 1);
  assert.strictEqual(counts.done, 1);
  assert.strictEqual(report.total, 7);
  assert.strictEqual(report.overdue, 1);
  assert.strictEqual(report.next.id, 'h1'); // просроченное — самое срочное
  assert.strictEqual(report.nextUpcoming.id, 'h2'); // а это ближайшее из будущих
  assert.strictEqual(report.byDay.length, 14);
  assert.strictEqual(report.byDay[0].count, 1);

  const progress = insights.progressOf(homeworks, '2026-10-13');
  assert.strictEqual(progress.percent, 14.3);
  assert.strictEqual(progress.dueSoon, 3);
});

test('historySeries: дельты, лучший и худший результат, спарклайны', () => {
  const snapshots = [
    { date: '2026-09-01', myPlace: 12, myAverage: 4.1, classAverage: 4.0, total: 26 },
    { date: '2026-09-08', myPlace: 9, myAverage: 4.2, classAverage: 4.0, total: 26 },
    { date: '2026-09-15', myPlace: 9, myAverage: 4.35, classAverage: 4.0, total: 26 },
    // Повтор той же даты должен заменить точку, а не добавить её.
    { date: '2026-09-15', myPlace: 7, myAverage: 4.4, classAverage: 4.0, total: 26 },
    { date: '2026-09-22', subjectId: 's-math', myPlace: 3, myAverage: 4.6, classAverage: 4.1, total: 26 }
  ];
  const series = insights.historySeries(snapshots, null);
  assert.strictEqual(series.count, 3);
  assert.strictEqual(series.firstPlace, 12);
  assert.strictEqual(series.lastPlace, 7);
  assert.strictEqual(series.placeDelta, 5);
  assert.strictEqual(series.averageDelta, 0.3);
  assert.strictEqual(series.bestPlace, 7);
  assert.strictEqual(series.bestPlaceDate, '2026-09-15');
  assert.strictEqual(series.trend, 1);
  assert.strictEqual(series.improved, true);
  assert.strictEqual(series.sparkline.length, 3);

  const math = insights.historySeries(snapshots, 's-math');
  assert.strictEqual(math.count, 1);
  assert.strictEqual(math.lastPlace, 3);
  assert.strictEqual(math.placeDelta, 0);
});

test('historyStore: хранит снимки по ученикам, экспортирует и импортирует', () => {
  const store = insights.createHistoryStore({ limit: 3 });
  store.append('me', { date: '2026-09-01', myPlace: 12, myAverage: 4.1 });
  store.append('me', { date: '2026-09-08', myPlace: 9, myAverage: 4.2 });
  store.append('me', { date: '2026-09-08', myPlace: 8, myAverage: 4.25 }); // перезапись
  store.append('sibling', { date: '2026-09-08', myPlace: 5, myAverage: 4.5 });
  store.append('me', { date: '2026-09-15', myPlace: 7, myAverage: 4.4 });
  store.append('me', { date: '2026-09-22', myPlace: 6, myAverage: 4.45 });
  store.append('me', { date: '2026-09-29', myPlace: 4, myAverage: 4.6 });

  const mine = store.all('me');
  assert.strictEqual(mine.length, 3); // старые снимки вытеснены лимитом
  assert.strictEqual(mine[0].date, '2026-09-15');
  assert.strictEqual(mine[2].myPlace, 4);
  assert.deepStrictEqual(store.counts(), { me: 3, sibling: 1 });

  const dumped = store.exportJson();
  const restored = insights.createHistoryStore({ limit: 5 });
  assert.strictEqual(restored.importJson(dumped), true);
  assert.strictEqual(restored.all('me').length, 3);
  assert.strictEqual(restored.all('sibling')[0].myAverage, 4.5);
  assert.strictEqual(restored.importJson('{'), false);

  store.clear('sibling');
  assert.strictEqual(store.all('sibling').length, 0);
});

test('searchItems: ищет по словам, приоритет — вкладки и предметы', () => {
  const items = [
    { id: 'v1', title: 'Рейтинг', subtitle: 'Место в классе', group: 'view', action: 'ranking' },
    { id: 'v2', title: 'Оценки', subtitle: 'Журнал оценок', group: 'view', action: 'marks' },
    { id: 's1', title: 'Математика', subtitle: 'Средний 4.5', group: 'subject', action: 'subject:1' },
    { id: 'h1', title: 'Домашние задания', subtitle: 'Физика, 3 несданных', group: 'view', action: 'homeworks' }
  ];
  const found = insights.searchItems(items, 'оценки');
  assert.strictEqual(found[0].id, 'v2');
  const words = insights.searchItems(items, 'физика несданных');
  assert.strictEqual(words[0].id, 'h1');
  assert.strictEqual(insights.searchItems(items, '').length, 0);
  assert.strictEqual(insights.searchItems(items, 'чего-то нет').length, 0);
});

test('compareBoards: сортирует предметы по месту и считает отрыв от класса', () => {
  const boards = [
    { subjectId: 's1', subjectName: 'Физика', summary: { myPlace: 8, myAverage: 4.2, classAverage: 4.0, total: 26, myTrend: 1 } },
    { subjectId: 's2', subjectName: 'Математика', summary: { myPlace: 2, myAverage: 4.8, classAverage: 4.3, total: 26, myTrend: 0 } }
  ];
  const rows = insights.compareBoards(boards);
  assert.strictEqual(rows[0].subjectName, 'Математика');
  assert.strictEqual(rows[0].gapToClass, 0.5);
  assert.strictEqual(rows[0].color, 'green');
  assert.strictEqual(rows[1].myPlace, 8);
});

test('snapshotFromBoard: готовит снимок для истории из ответа платформы', () => {
  const snapshot = insights.snapshotFromBoard({
    date: '2026-10-12',
    subjectId: null,
    rows: new Array(26).fill({}),
    summary: { myPlace: 5, myAverage: 4.6, classAverage: 4.1, total: 26 }
  });
  assert.strictEqual(snapshot.date, '2026-10-12');
  assert.strictEqual(snapshot.myPlace, 5);
  assert.strictEqual(snapshot.myAverage, 4.6);
  assert.strictEqual(snapshot.total, 26);
  assert.ok(snapshot.savedAt > 0);
  assert.strictEqual(util.toIso(snapshot.date), '2026-10-12');
});

test('нативный мост: без бинарника деградирует к JS, не ломая интерфейс', () => {
  assert.strictEqual(native.isNode, true);
  assert.strictEqual(typeof native.locateBinary, 'function');
  // Явно несуществующий путь не должен «находиться».
  assert.notStrictEqual(native.locateBinary({ binary: '/nope/mesh-rank' }), '/nope/mesh-rank');

  const descriptor = native.descriptor();
  assert.ok(descriptor.engine === 'js' || descriptor.engine === 'rust');
  assert.ok(typeof descriptor.calls === 'number');

  const accelerator = native.createAccelerator({ binary: '/nope/mesh-rank' });
  if (accelerator) {
    // Бинарник есть: проверяем форму API, но ничего не запускаем.
    ['rankBoard', 'summarizeMarks', 'deadlines', 'forecast', 'impact', 'csvRank', 'describe', 'dispose']
      .forEach((name) => assert.strictEqual(typeof accelerator[name], 'function', name));
  } else {
    assert.ok(/не найден/.test(descriptor.reason || '') || descriptor.reason === null || descriptor.engine === 'js');
  }
  native.reset();
});

test('страница без Node получает заглушку моста (браузер/Android)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'core', 'native.js'), 'utf8');
  assert.ok(source.includes('MeshNativeBridge'), 'в браузере должен быть объект-заглушка');
  assert.ok(source.includes("available: function () { return false; }"));
});
