/*!
 * Mesh Ranker — ускоритель вычислений (UMD).
 *
 * Единая точка входа для «горячих» расчётов: если рядом есть нативное ядро на
 * Rust, считаем на нём, иначе — на JS. Интерфейсу не нужно знать, какой движок
 * под рукой: он получает ответ и метку `engine`, а в настройках видно, сколько
 * вызовов ушло в Rust и сколько миллисекунд это сэкономило.
 *
 * Правило номер один: любая проблема нативного ядра (нет бинарника, упал,
 * не ответил вовремя) не должна ломать интерфейс — тогда считает JS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./native.js'),
      require('./lib/insights.js'),
      require('./lib/stats.js')
    );
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    lib.accelerate = factory(root.MeshNativeBridge, lib.insights, lib.stats);
  }
})(typeof self !== 'undefined' ? self : this, function (bridge, insights, stats) {
  'use strict';

  // Соответствие «наш метод → метод моста JSON-lines» (см. bridge.rs).
  var BRIDGE_METHOD = {
    forecast: 'insights.forecast',
    impact: 'insights.impact',
    whatIf: 'insights.whatIf',
    deadlines: 'homeworks.deadlines',
    history: 'insights.history',
    marksSummary: 'marks.summarize',
    rankBoard: 'rank.build',
    schedule: 'schedule.normalize',
    csvRank: 'csv.rank',
    bench: 'bench'
  };

  var accelerator = null;
  var stats_ = {
    calls: 0,
    native: 0,
    local: 0,
    fallbacks: 0,
    nativeMs: 0,
    localMs: 0,
    lastEngine: 'js',
    lastError: null,
    /** Оценка экономии: сколько миллисекунд сэкономил Rust по сравнению с JS. */
    savedMs: 0
  };
  var localProfile = {}; // метод → среднее время JS-вычисления, мс

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** Подключает ускоритель (обычно `MeshNativeBridge.createAccelerator()`). */
  function attach(candidate) {
    accelerator = candidate || null;
    return api.engine();
  }

  function createAccelerator(options) {
    if (!bridge || !bridge.createAccelerator) return null;
    return bridge.createAccelerator(options);
  }

  /** Описание состояния: движок, версия, счётчики, оценка экономии. */
  function engine() {
    var native = null;
    if (accelerator && accelerator.describe) {
      try { native = accelerator.describe(); } catch (error) { native = null; }
    }
    if (!native && bridge && bridge.descriptor) {
      try { native = bridge.descriptor(); } catch (error) { native = null; }
    }
    var performance_ = {};
    Object.keys(localProfile).forEach(function (method) {
      performance_[method] = Math.round(localProfile[method] * 100) / 100;
    });
    return {
      engine: accelerator ? 'rust' : 'js',
      available: !!accelerator,
      native: native,
      calls: stats_.calls,
      nativeCalls: stats_.native,
      localCalls: stats_.local,
      fallbacks: stats_.fallbacks,
      savedMs: Math.round(stats_.savedMs * 10) / 10,
      nativeMs: Math.round(stats_.nativeMs * 10) / 10,
      localMs: Math.round(stats_.localMs * 10) / 10,
      lastEngine: stats_.lastEngine,
      lastError: stats_.lastError,
      localProfile: performance_
    };
  }

  function recordLocal(method, ms) {
    var previous = localProfile[method];
    localProfile[method] = previous === undefined ? ms : previous * 0.7 + ms * 0.3;
  }

  /**
   * Считает через нативное ядро, при любой неудаче — через JS.
   *
   * @param {string} method имя метода (`forecast`, `impact`, …)
   * @param {object} params аргументы для Rust-моста
   * @param {Function} localFn запасная JS-реализация без аргументов
   * @returns {Promise<{value:*, engine:string, ms:number, fallback:boolean}>}
   */
  function run(method, params, localFn) {
    stats_.calls += 1;
    var nativeMethod = BRIDGE_METHOD[method] || method;

    function local(error) {
      var started = now();
      var value = localFn();
      var ms = now() - started;
      recordLocal(method, ms);
      stats_.local += 1;
      stats_.localMs += ms;
      stats_.lastEngine = 'js';
      if (error) {
        stats_.fallbacks += 1;
        stats_.lastError = error.message || String(error);
      }
      return { value: value, engine: 'js', ms: ms, fallback: !!error, error: error ? (error.message || String(error)) : null };
    }

    if (!accelerator || typeof accelerator.raw !== 'function') return Promise.resolve(local(null));

    return accelerator.raw(nativeMethod, params).then(function (result) {
      stats_.native += 1;
      stats_.lastEngine = 'rust';
      var localEstimate = localProfile[method] || 0;
      stats_.savedMs += Math.max(0, localEstimate - 0.05);
      return { value: result, engine: 'rust', ms: 0, fallback: false, error: null };
    }, function (error) {
      return local(error);
    });
  }

  // ------------------------------------------------------- конкретные вызовы ---

  function forecast(marks, target, remaining, localFn) {
    var local = localFn || function () { return insights.forecast(marks, target, remaining); };
    return run('forecast', { marks: marks, target: target, remaining: remaining }, local);
  }

  function impact(marks, limit, localFn) {
    var local = localFn || function () { return insights.subjectImpact(marks, limit); };
    return run('impact', { marks: marks, limit: limit }, local);
  }

  function deadlines(homeworks, reference, localFn) {
    var local = localFn || function () { return insights.deadlines(homeworks, reference); };
    return run('deadlines', { homeworks: homeworks, reference: reference }, local);
  }

  function history(snapshots, subjectId, localFn) {
    var local = localFn || function () { return insights.historySeries(snapshots, subjectId); };
    return run('history', { snapshots: snapshots, subjectId: subjectId }, local);
  }

  function marksSummary(marks, localFn) {
    var local = localFn || function () { return null; };
    return run('marksSummary', { marks: marks }, local);
  }

  function schedule(payload, localFn) {
    var local = localFn || function () { return null; };
    return run('schedule', { payload: payload }, local);
  }

  function csvRank(rows, title, localFn) {
    var local = localFn || function () { return null; };
    return run('csvRank', { rows: rows, title: title }, local);
  }

  function bench(params) {
    return run('bench', params || {}, function () { return stats.describe([]); });
  }

  function reset() {
    stats_ = { calls: 0, native: 0, local: 0, fallbacks: 0, nativeMs: 0, localMs: 0, lastEngine: 'js', lastError: null, savedMs: 0 };
    localProfile = {};
    if (bridge && bridge.reset) bridge.reset();
  }

  var api = {
    attach: attach,
    createAccelerator: createAccelerator,
    engine: engine,
    run: run,
    forecast: forecast,
    impact: impact,
    deadlines: deadlines,
    history: history,
    marksSummary: marksSummary,
    schedule: schedule,
    csvRank: csvRank,
    bench: bench,
    reset: reset,
    isNative: function () { return !!accelerator; }
  };

  // Автоподключение: если мы в Node и бинарник уже собран — используем его.
  var auto = null;
  try {
    auto = api.createAccelerator({});
  } catch (error) {
    auto = null;
  }
  if (auto) accelerator = auto;

  return api;
});
