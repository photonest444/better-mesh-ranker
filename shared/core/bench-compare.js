/*!
 * Mesh Ranker — сравнение скорости вычислений JS и Rust (UMD).
 *
 * Показывает на реальных данных приложения, сколько выигрывает нативное ядро:
 * одинаковый набор «членов класса» прогоняется через JS-ядро и через
 * `mesh-rank bench`, а рядом выводятся миллисекунды на операцию и ускорение.
 * Используется в разделе «Производительность» и в `/api/bench`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./mesh-core.js'), require('./native.js'));
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    lib.benchCompare = factory(root.MeshCore, root.MeshNativeBridge);
  }
})(typeof self !== 'undefined' ? self : this, function (core, native) {
  'use strict';

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function round(value, digits) {
    var factor = Math.pow(10, digits === undefined ? 3 : digits);
    return Math.round(value * factor) / factor;
  }

  /** Детерминированные «члены класса» — чтобы замеры повторялись. */
  function syntheticMembers(count) {
    var total = Math.max(1, count || 26);
    var members = [];
    for (var index = 0; index < total; index += 1) {
      // Псевдослучайно, но воспроизводимо: тот же ряд при каждом запуске.
      // Форма ответа МЭШ (rank/previousRank) — та же, что приходит из API.
      var base = 3 + ((index * 37) % 20) / 10;
      var average = round(base + ((index * 13) % 7) / 100, 3);
      var previous = round(Math.max(2, average - (((index % 5) - 2) / 10)), 3);
      var place = index + 1;
      var previousPlace = Math.max(1, place + ((index % 3) - 1));
      members.push({
        personId: 'bench-' + index,
        rank: { averageMarkFive: average, average_mark: average, rankPlace: place, rankStatus: index % 2 ? 'mid' : 'high' },
        previousRank: { averageMarkFive: previous, average_mark: previous, rankPlace: previousPlace },
        marksCount: 10 + ((index * 7) % 25),
        isMe: index === 0
      });
    }
    return members;
  }

  /** Замер JS-ядра: сборка таблицы рейтинга + сводка. */
  function runJs(options) {
    var opts = options || {};
    var iterations = Math.max(1, opts.iterations || 200);
    var members = syntheticMembers(opts.rows || 26);
    var names = {};
    members.forEach(function (member, index) { names[member.personId] = 'Ученик ' + (index + 1); });
    var context = { names: names, meId: members[0].personId, date: opts.date || '2026-10-12' };

    var started = now();
    var rows = [];
    for (var index = 0; index < iterations; index += 1) {
      rows = core.buildRankTable(members, context);
    }
    var buildMs = now() - started;

    started = now();
    var summary = null;
    for (var pass = 0; pass < iterations; pass += 1) {
      summary = core.summarizeRank(rows, members[0].personId);
    }
    var summarizeMs = now() - started;

    var perOpMs = (buildMs + summarizeMs) / iterations;
    return {
      rows: members.length,
      iterations: iterations,
      buildMs: round(buildMs, 2),
      summarizeMs: round(summarizeMs, 2),
      perOpMs: round(perOpMs, 4),
      opsPerSecond: Math.round(1000 / Math.max(perOpMs, 0.0001)),
      myPlace: summary.myPlace,
      classAverage: summary.classAverage
    };
  }

  /**
   * Сравнение движков.
   *
   * @param {{accelerator?:object, rows?:number, iterations?:number, marks?:number, js?:object}} options
   * @returns {Promise<{engine:string, js:object, rust:object|null, speedup:number|null, note:string}>}
   */
  function compare(options) {
    var opts = options || {};
    var iterations = Math.max(1, opts.iterations || 200);
    var jsReport = opts.js || runJs({ rows: opts.rows, iterations: iterations, date: opts.date });
    var accelerator = opts.accelerator;
    // autoDetect: false — «сравнивать не с чем», даже если рядом лежит бинарник.
    if (!accelerator && opts.autoDetect !== false && native && native.createAccelerator) {
      try { accelerator = native.createAccelerator(opts); } catch (error) { accelerator = null; }
    }
    if (!accelerator || typeof accelerator.bench !== 'function') {
      return Promise.resolve({
        engine: 'js',
        js: jsReport,
        rust: null,
        speedup: null,
        note: 'Нативное ядро не найдено: считает JS. Соберите mesh-rank (cargo build --release), чтобы включить ускорение.'
      });
    }

    return accelerator.bench({
      students: opts.rows || 26,
      marks: opts.marks || 120,
      iterations: iterations
    }).then(function (report) {
      var timings = (report && report.timings) || {};
      var rustPerOpMs = Number(timings.rankTableMs || 0) / iterations;
      var rustOps = Number(timings.rankTablePerSecond || (rustPerOpMs ? 1000 / rustPerOpMs : 0));
      var rust = {
        perOpMs: round(rustPerOpMs, 4),
        opsPerSecond: Math.round(rustOps),
        timings: timings,
        checksum: report && report.checksum
      };
      var speedup = rustOps && jsReport.opsPerSecond ? round(rustOps / jsReport.opsPerSecond, 2) : null;
      var note = speedup && speedup > 1
        ? 'Rust быстрее в ' + speedup + '× на сборке таблицы рейтинга'
        : 'Скорость сопоставима: данные маленькие, расходы на вывод заметны';
      return { engine: 'rust', js: jsReport, rust: rust, speedup: speedup, note: note };
    }).catch(function (error) {
      return {
        engine: 'js',
        js: jsReport,
        rust: null,
        speedup: null,
        note: 'Нативное ядро не ответило (' + (error.message || error) + ') — сравнивать нечего'
      };
    });
  }

  return {
    syntheticMembers: syntheticMembers,
    runJs: runJs,
    compare: compare
  };
});
