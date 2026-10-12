/*!
 * Mesh Ranker — работа с табличными данными: сортировка, фильтры, страницы, итоги.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'), require('./stats.js'), require('./format.js'));
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    lib.table = factory(lib.util, lib.stats, lib.format);
  }
})(typeof self !== 'undefined' ? self : this, function (util, stats, format) {
  'use strict';

  var TYPE_MAP = {
    text: function (v) { return util.asStr(v).toLowerCase(); },
    number: function (v) { return util.asNum(v, null); },
    date: function (v) { return util.isBlank(v) ? null : util.parseIso(util.toIso(v)).getTime(); },
    boolean: function (v) { return util.asBool(v) ? 1 : 0; }
  };

  function valueOf(row, column) {
    if (!column) return null;
    if (typeof column.value === 'function') return column.value(row);
    if (typeof column.value === 'string') return util.deepGet(row, column.value, null);
    return util.deepGet(row, column.key, null);
  }

  /**
   * Сортировка строк. Пустые значения всегда в конце, порядок устойчивый.
   * @param {Array} rows
   * @param {{key:string, value?:Function|string, type?:string, dir?:'asc'|'desc'}} options
   */
  function sortRows(rows, options) {
    var o = options || {};
    var type = (o.type || columnTypeGuess(rows, o)) || 'text';
    var cast = TYPE_MAP[type] || TYPE_MAP.text;
    var dir = o.dir === 'desc' ? -1 : 1;
    var key = o.key;
    var valueFn = o.value;
    return (rows || []).map(function (row, index) { return { row: row, index: index }; })
      .sort(function (a, b) {
        var av = cast(valueFn ? (typeof valueFn === 'function' ? valueFn(a.row) : util.deepGet(a.row, valueFn, null)) : util.deepGet(a.row, key, null));
        var bv = cast(valueFn ? (typeof valueFn === 'function' ? valueFn(b.row) : util.deepGet(b.row, valueFn, null)) : util.deepGet(b.row, key, null));
        var aEmpty = av === null || av === '' || (typeof av === 'number' && isNaN(av));
        var bEmpty = bv === null || bv === '' || (typeof bv === 'number' && isNaN(bv));
        if (aEmpty && bEmpty) return a.index - b.index;
        if (aEmpty) return 1;
        if (bEmpty) return -1;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return a.index - b.index;
      })
      .map(function (item) { return item.row; });
  }

  function columnTypeGuess(rows, options) {
    var sample = (rows || []).slice(0, 20);
    for (var i = 0; i < sample.length; i++) {
      var v = util.deepGet(sample[i], options.key, null);
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number') return 'number';
      if (typeof v === 'boolean') return 'boolean';
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return 'date';
      if (String(v).indexOf(',') > 0) return 'text';
      return typeof v === 'string' && !isNaN(v) ? 'number' : 'text';
    }
    return 'text';
  }

  /** Поиск по всем указанным полям (или по всей строке, если поля не заданы). */
  function filterRows(rows, query, options) {
    var q = util.asStr(query).trim().toLowerCase();
    if (!q) return (rows || []).slice();
    var o = options || {};
    var keys = o.keys || [];
    var valueFn = o.value;
    return (rows || []).filter(function (row) {
      var haystack;
      if (typeof valueFn === 'function') haystack = util.asStr(valueFn(row)).toLowerCase();
      else if (keys.length) haystack = keys.map(function (k) { return util.asStr(util.deepGet(row, k, '')); }).join(' ').toLowerCase();
      else haystack = JSON.stringify(row).toLowerCase();
      return haystack.indexOf(q) >= 0;
    });
  }

  /**
   * Пофильтровые фильтры (селекты над таблицей).
   * filters: { gender: 'all'|value, subjectId: 'all'|'12', ... }
   */
  function applyColumnFilters(rows, filters, columnMap) {
    var out = rows || [];
    Object.keys(filters || {}).forEach(function (key) {
      var wanted = filters[key];
      if (wanted === undefined || wanted === null || wanted === '' || wanted === 'all') return;
      var fn = columnMap && columnMap[key];
      var wantedList = Array.isArray(wanted) ? wanted.map(String) : null;
      out = out.filter(function (row) {
        var value = typeof fn === 'function' ? fn(row) : util.deepGet(row, fn || key, null);
        if (wantedList) return wantedList.indexOf(util.asStr(value)) >= 0;
        if (typeof wanted === 'boolean') return util.asBool(value) === wanted;
        return util.asStr(value) === util.asStr(wanted);
      });
    });
    return out;
  }

  function paginate(rows, page, pageSize) {
    var list = rows || [];
    var size = Math.max(1, pageSize || 50);
    var pages = Math.max(1, Math.ceil(list.length / size));
    var current = util.clamp(page || 1, 1, pages);
    var from = (current - 1) * size;
    return {
      rows: list.slice(from, from + size),
      page: current,
      pages: pages,
      pageSize: size,
      total: list.length,
      from: list.length ? from + 1 : 0,
      to: Math.min(list.length, from + size)
    };
  }

  function groupBy(rows, keyFn) {
    var groups = Object.create(null);
    (rows || []).forEach(function (row) {
      var key = typeof keyFn === 'function' ? keyFn(row) : util.deepGet(row, keyFn, '—');
      if (key === null || key === undefined || key === '') key = '—';
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    });
    return groups;
  }

  /** Итоги по числовым колонкам таблицы (для строки "Итого" под таблицей). */
  function summarize(rows, columns) {
    var out = {};
    (columns || []).forEach(function (column) {
      if (column.type !== 'number' && column.summary !== true) return;
      var nums = stats.values(rows || [], function (row) { return valueOf(row, column); });
      out[column.key] = {
        count: nums.length,
        mean: util.round(stats.mean(nums), 2),
        median: util.round(stats.median(nums), 2),
        min: stats.min(nums),
        max: stats.max(nums)
      };
    });
    return out;
  }

  /** Многокритериальная сортировка: [{key, type, dir}, ...] */
  function multiSort(rows, criteria) {
    var list = (rows || []).slice();
    (criteria || []).slice().reverse().forEach(function (criterion) {
      list = sortRows(list, criterion);
    });
    return list;
  }

  /** Уникальные значения колонки — для построения селектов-фильтров. */
  function distinctValues(rows, keyOrFn, limit) {
    var seen = Object.create(null);
    var out = [];
    (rows || []).forEach(function (row) {
      var value = typeof keyOrFn === 'function' ? keyOrFn(row) : util.deepGet(row, keyOrFn, null);
      if (value === null || value === undefined || value === '') return;
      var key = util.asStr(value);
      if (seen[key]) return;
      seen[key] = true;
      out.push(value);
    });
    var sorted = out.sort(function (a, b) {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      return util.asStr(a).localeCompare(util.asStr(b), 'ru');
    });
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** Рендер «полосы» для визуализации значения внутри строки таблицы. */
  function bar(value, max, options) {
    var o = options || {};
    var v = util.asNum(value, 0);
    var m = util.asNum(max, 1) || 1;
    var width = util.clamp((v / m) * 100, 0, 100);
    return {
      width: util.round(width, 1),
      text: o.text === undefined ? format.markShort(v) : o.text,
      color: o.color || stats.gradeColor(v)
    };
  }

  return {
    valueOf: valueOf,
    columnTypeGuess: columnTypeGuess,
    sortRows: sortRows,
    multiSort: multiSort,
    filterRows: filterRows,
    applyColumnFilters: applyColumnFilters,
    paginate: paginate,
    groupBy: groupBy,
    summarize: summarize,
    distinctValues: distinctValues,
    bar: bar
  };
});
