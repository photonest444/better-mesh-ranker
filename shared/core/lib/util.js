/*!
 * Mesh Ranker — общие утилиты (UMD).
 *
 * Файл намеренно написан в формате UMD (IIFE + module.exports):
 * он используется и как обычный <script> в WebView/Electron (file://),
 * и через require() в тестах Node. Модули ES из file:// блокируются CORS,
 * поэтому классические скрипты — самый надёжный вариант.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.MeshLib = root.MeshLib || {}).util = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Достаёт значение по пути "a.b.c", безопасно к отсутствующим узлам. */
  function deepGet(obj, path, fallback) {
    var cur = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined) return fallback;
      cur = cur[parts[i]];
    }
    return cur === undefined || cur === null ? fallback : cur;
  }

  /** Первое непустое значение из списка (полезно, когда API отдаёт поля по-разному). */
  function firstDefined() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function asNum(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback === undefined ? null : fallback;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return isNaN(n) ? (fallback === undefined ? null : fallback) : n;
  }

  function asInt(v, fallback) {
    var n = asNum(v, fallback);
    return n === null || n === undefined ? n : Math.trunc(n);
  }

  function asBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    var s = String(v || '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'да' || s === 'yes';
  }

  function asStr(v, fallback) {
    if (v === null || v === undefined) return fallback === undefined ? '' : fallback;
    return String(v);
  }

  function isBlank(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function round(v, digits) {
    if (v === null || v === undefined) return null;
    var k = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round((v + Number.EPSILON) * k) / k;
  }

  function uniqBy(rows, keyFn) {
    var seen = Object.create(null);
    var out = [];
    (rows || []).forEach(function (row) {
      var key = keyFn(row);
      if (seen[key]) return;
      seen[key] = true;
      out.push(row);
    });
    return out;
  }

  function escapeHtml(v) {
    return asStr(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- даты ----

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** ISO-дата (YYYY-MM-DD) из Date или строки; без часовых поясов. */
  function toIso(value) {
    if (value instanceof Date) {
      return value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate());
    }
    var s = asStr(value).trim();
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    // поддержка dd.mm.yyyy
    var ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (ru) return ru[3] + '-' + ru[2] + '-' + ru[1];
    return todayIso();
  }

  function todayIso() { return toIso(new Date()); }

  function parseIso(iso) {
    var m = asStr(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date();
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function addDays(iso, days) {
    var d = parseIso(iso);
    d.setDate(d.getDate() + days);
    return toIso(d);
  }

  function addMonths(iso, months) {
    var d = parseIso(iso);
    d.setMonth(d.getMonth() + months);
    return toIso(d);
  }

  function daysBetween(fromIso, toIsoStr) {
    var a = parseIso(fromIso).getTime();
    var b = parseIso(toIsoStr).getTime();
    return Math.round((b - a) / 86400000);
  }

  /** Первый день учебного года (1 сентября) для даты. */
  function schoolYearStart(iso) {
    var d = parseIso(iso);
    var year = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    return year + '-09-01';
  }

  function eachDay(fromIso, toIsoStr, limit) {
    var out = [];
    var cur = toIso(fromIso);
    var last = toIso(toIsoStr);
    var max = limit === undefined ? 400 : limit;
    while (daysBetween(cur, last) >= 0 && out.length < max) {
      out.push(cur);
      cur = addDays(cur, 1);
    }
    return out;
  }

  // ---------------------------------------------------------------- сеть ---

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function nextTick() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { resolve(); });
      else setTimeout(resolve, 0);
    });
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 250);
    };
  }

  function uuid() {
    var rnd = function () { return Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1); };
    return rnd() + rnd() + '-' + rnd() + '-' + rnd() + '-' + rnd() + '-' + rnd() + rnd() + rnd();
  }

  function slugify(v) {
    return asStr(v).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '') || 'item';
  }

  return {
    deepGet: deepGet,
    firstDefined: firstDefined,
    asNum: asNum,
    asInt: asInt,
    asBool: asBool,
    asStr: asStr,
    isBlank: isBlank,
    clamp: clamp,
    round: round,
    uniqBy: uniqBy,
    escapeHtml: escapeHtml,
    toIso: toIso,
    todayIso: todayIso,
    parseIso: parseIso,
    addDays: addDays,
    addMonths: addMonths,
    daysBetween: daysBetween,
    schoolYearStart: schoolYearStart,
    eachDay: eachDay,
    sleep: sleep,
    nextTick: nextTick,
    debounce: debounce,
    uuid: uuid,
    slugify: slugify
  };
});
