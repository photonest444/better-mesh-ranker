/*!
 * Mesh Ranker — статистика и цвета оценок (UMD).
 *
 * Node:      const stats = require('.../lib/stats.js')
 * Браузер:   <script src="lib/util.js"></script> затем <script src="lib/stats.js"></script>
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'));
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    lib.stats = factory(lib.util);
  }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  function values(rows, keyFn) {
    var out = [];
    (rows || []).forEach(function (row) {
      var v = typeof keyFn === 'function' ? keyFn(row) : row;
      if (v !== null && v !== undefined && v !== '' && !isNaN(v)) out.push(Number(v));
    });
    return out;
  }

  function sum(nums) {
    return (nums || []).reduce(function (acc, n) { return acc + n; }, 0);
  }

  function mean(nums) {
    var list = nums || [];
    return list.length ? sum(list) / list.length : null;
  }

  function median(nums) {
    var list = (nums || []).slice().sort(function (a, b) { return a - b; });
    if (!list.length) return null;
    var mid = Math.floor(list.length / 2);
    return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
  }

  function min(nums) { return (nums || []).length ? Math.min.apply(null, nums) : null; }
  function max(nums) { return (nums || []).length ? Math.max.apply(null, nums) : null; }

  function stdDev(nums) {
    var m = mean(nums);
    if (m === null || (nums || []).length < 2) return null;
    var variance = sum(nums.map(function (n) { return (n - m) * (n - m); })) / (nums.length - 1);
    return Math.sqrt(variance);
  }

  /** Квантиль (0..1) методом линейной интерполяции. */
  function percentile(nums, q) {
    var list = (nums || []).slice().sort(function (a, b) { return a - b; });
    if (!list.length) return null;
    var pos = util.clamp(q, 0, 1) * (list.length - 1);
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    if (lo === hi) return list[lo];
    return list[lo] + (list[hi] - list[lo]) * (pos - lo);
  }

  /** Гистограмма по «сырым» значениям (шаг по умолчанию — 1). */
  function distribution(nums, step) {
    var list = nums || [];
    if (!list.length) return [];
    var bucket = step || 1;
    var counts = Object.create(null);
    list.forEach(function (n) {
      var key = Math.round(n / bucket) * bucket;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts)
      .map(function (k) { return { value: Number(k), count: counts[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  /** Гистограмма по диапазону (для средних баллов: 2.0 … 5.0 шагом 0.5). */
  function histogram(nums, from, to, step) {
    var list = nums || [];
    var lo = from === undefined ? 2 : from;
    var hi = to === undefined ? 5 : to;
    var s = step || 0.5;
    var buckets = [];
    for (var v = hi; v >= lo - 1e-9; v -= s) {
      var upper = v + s;
      buckets.push({
        from: util.round(v, 2),
        to: util.round(Math.min(upper, hi), 2),
        label: util.round(v, 1) + '–' + util.round(Math.min(upper, hi), 1),
        count: list.filter(function (n) { return n >= v - 1e-9 && n < upper - 1e-9; }).length
      });
    }
    return buckets;
  }

  /** Место значения в списке (1 — лучшее, равные значения получают одно место). */
  function placeOf(nums, value) {
    if (value === null || value === undefined || !(nums || []).length) return null;
    var better = 0;
    nums.forEach(function (n) { if (n > value + 1e-9) better++; });
    return better + 1;
  }

  /** Цвет оценки: 5 — зелёный, 4 — жёлтый, 3 — оранжевый, ниже — красный. */
  function gradeColor(mark) {
    if (mark === null || mark === undefined || mark === '') return 'none';
    var rounded = Math.round(Number(mark));
    if (rounded >= 5) return 'green';
    if (rounded === 4) return 'yellow';
    if (rounded === 3) return 'orange';
    return 'red';
  }

  /** Цвет относительного показателя (место в классе). */
  function placeColor(place, total) {
    if (!place || !total) return 'none';
    var share = place / total;
    if (share <= 0.15) return 'green';
    if (share <= 0.4) return 'yellow';
    if (share <= 0.7) return 'orange';
    return 'red';
  }

  /** Направление изменения: 1 — рост, -1 — падение, 0 — без изменений. */
  function trendDirection(current, previous, epsilon) {
    if (current === null || current === undefined || previous === null || previous === undefined) return 0;
    var eps = epsilon === undefined ? 0.005 : epsilon;
    if (current - previous > eps) return 1;
    if (previous - current > eps) return -1;
    return 0;
  }

  /** Сводка по набору чисел (для карточек «средний балл класса» и т.п.). */
  function describe(nums) {
    var list = nums || [];
    return {
      count: list.length,
      mean: util.round(mean(list), 2),
      median: util.round(median(list), 2),
      min: min(list),
      max: max(list),
      stdDev: util.round(stdDev(list), 2),
      p25: util.round(percentile(list, 0.25), 2),
      p75: util.round(percentile(list, 0.75), 2)
    };
  }

  return {
    values: values,
    sum: sum,
    mean: mean,
    median: median,
    min: min,
    max: max,
    stdDev: stdDev,
    percentile: percentile,
    distribution: distribution,
    histogram: histogram,
    placeOf: placeOf,
    gradeColor: gradeColor,
    placeColor: placeColor,
    trendDirection: trendDirection,
    describe: describe
  };
});
