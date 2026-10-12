/*!
 * Mesh Ranker — форматирование значений и экспорт (UMD).
 * Экспорт CSV делается с BOM и разделителем ";" — так Excel в русской локали
 * открывает файл сразу по столбцам.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./util.js'));
  } else {
    var lib = (root.MeshLib = root.MeshLib || {});
    lib.format = factory(lib.util);
  }
})(typeof self !== 'undefined' ? self : this, function (util) {
  'use strict';

  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  var WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

  function pluralRu(n, one, few, many) {
    var abs = Math.abs(Number(n) || 0) % 100;
    var last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  /** 4.6666 -> "4.67"; null -> "—" */
  function mark(value, digits) {
    if (value === null || value === undefined || value === '' || isNaN(value)) return '—';
    var d = digits === undefined ? 2 : digits;
    return Number(value).toFixed(d);
  }

  function markShort(value) {
    if (value === null || value === undefined || value === '' || isNaN(value)) return '—';
    return String(util.round(Number(value), 2)).replace('.', ',');
  }

  /** +0.24 / -0.10 / "=" */
  function delta(current, previous, digits) {
    if (current === null || previous === null || current === undefined || previous === undefined) return '—';
    var d = Number(current) - Number(previous);
    var dg = digits === undefined ? 2 : digits;
    var sign = d > 0 ? '+' : '';
    return sign + d.toFixed(dg);
  }

  function trendArrow(direction) {
    if (direction > 0) return '▲';
    if (direction < 0) return '▼';
    return '=';
  }

  function percent(value, digits) {
    if (value === null || value === undefined) return '—';
    return (Number(value) * 100).toFixed(digits === undefined ? 0 : digits) + '%';
  }

  /** "2026-10-12" -> "12 октября 2026" */
  function dateRu(iso, opts) {
    var o = opts || {};
    var d = util.parseIso(iso);
    var out = d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    if (o.weekday) out = WEEKDAYS[d.getDay() === 0 ? 6 : d.getDay() - 1] + ', ' + out;
    return out;
  }

  /** "2026-10-12" -> "12.10.2026" */
  function dateShort(iso) {
    if (util.isBlank(iso)) return '—';
    var s = util.toIso(iso);
    return s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4);
  }

  /** "2026-10-12" -> "12.10" */
  function dateDayMonth(iso) {
    var s = util.toIso(iso);
    return s.slice(8, 10) + '.' + s.slice(5, 7);
  }

  function weekdayShort(iso) {
    var d = util.parseIso(iso);
    return WEEKDAYS_SHORT[d.getDay() === 0 ? 6 : d.getDay() - 1];
  }

  function monthName(index) { return MONTHS_NOM[index]; }

  /** Диапазон дат: "01.09 — 12.10.2026" */
  function dateRangeText(fromIso, toIsoStr) {
    var a = util.toIso(fromIso);
    var b = util.toIso(toIsoStr);
    if (a.slice(0, 4) === b.slice(0, 4)) {
      if (a.slice(0, 7) === b.slice(0, 7)) {
        return a.slice(8, 10) + ' — ' + dateShort(b);
      }
      return a.slice(8, 10) + '.' + a.slice(5, 7) + ' — ' + dateShort(b);
    }
    return dateShort(a) + ' — ' + dateShort(b);
  }

  /** Относительное время: "5 минут назад" */
  function relativeTime(timestamp) {
    if (!timestamp) return 'никогда';
    var diff = Date.now() - Number(timestamp);
    var min = Math.round(diff / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return min + ' ' + pluralRu(min, 'минуту', 'минуты', 'минут') + ' назад';
    var hours = Math.round(min / 60);
    if (hours < 24) return hours + ' ' + pluralRu(hours, 'час', 'часа', 'часов') + ' назад';
    var days = Math.round(hours / 24);
    return days + ' ' + pluralRu(days, 'день', 'дня', 'дней') + ' назад';
  }

  function studentsCount(n) {
    return n + ' ' + pluralRu(n, 'ученик', 'ученика', 'учеников');
  }

  function lessonsCount(n) {
    return n + ' ' + pluralRu(n, 'урок', 'урока', 'уроков');
  }

  function marksCount(n) {
    return n + ' ' + pluralRu(n, 'оценка', 'оценки', 'оценок');
  }

  /** Обрезка длинного текста для ячеек таблицы. */
  function truncate(text, max) {
    var s = util.asStr(text).replace(/\s+/g, ' ').trim();
    var limit = max || 120;
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
  }

  // ----------------------------------------------------------- CSV/экспорт --

  function csvCell(value, sep) {
    var s = value === null || value === undefined ? '' : String(value);
    s = s.replace(/\r?\n/g, ' ');
    if (s.indexOf('"') >= 0) s = s.replace(/"/g, '""');
    if (s.indexOf(sep) >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0 || /^\s|\s$/.test(s)) {
      s = '"' + s + '"';
    }
    return s;
  }

  /**
   * rows: массив объектов; columns: [{key, title, value?}]
   * opts: {sep=';', bom=true, title}
   */
  function toCsv(rows, columns, opts) {
    var o = opts || {};
    var sep = o.sep || ';';
    var cols = columns || [];
    var lines = [];
    if (o.title) lines.push(csvCell(o.title, sep));
    lines.push(cols.map(function (c) { return csvCell(c.title || c.key, sep); }).join(sep));
    (rows || []).forEach(function (row, index) {
      lines.push(cols.map(function (c) {
        var value = typeof c.value === 'function' ? c.value(row, index) : util.deepGet(row, c.key, '');
        return csvCell(value, sep);
      }).join(sep));
    });
    var body = lines.join('\r\n');
    return (o.bom === false ? '' : '\uFEFF') + body;
  }

  /** Текстовый «отчёт» таблицы (для копирования в буфер обмена). */
  function toTextTable(rows, columns) {
    var cols = columns || [];
    var widths = cols.map(function (c) {
      var max = util.asStr(c.title || c.key).length;
      (rows || []).forEach(function (row) {
        var value = typeof c.value === 'function' ? c.value(row) : util.deepGet(row, c.key, '');
        max = Math.max(max, util.asStr(value).length);
      });
      return Math.min(max, 40);
    });
    var pad = function (text, width) {
      var s = util.asStr(text);
      if (s.length > width) s = s.slice(0, width - 1) + '…';
      return s + new Array(Math.max(1, width - s.length + 1)).join(' ');
    };
    var head = cols.map(function (c, i) { return pad(c.title || c.key, widths[i]); }).join(' | ');
    var sep = widths.map(function (w) { return new Array(w + 1).join('-'); }).join('-+-');
    var body = (rows || []).map(function (row) {
      return cols.map(function (c, i) {
        var value = typeof c.value === 'function' ? c.value(row) : util.deepGet(row, c.key, '');
        return pad(value, widths[i]);
      }).join(' | ');
    });
    return [head, sep].concat(body).join('\n');
  }

  /** Имя файла для экспорта: mesh-rating-2026-10-12.csv */
  function exportFileName(kind, iso, ext) {
    var stamp = util.toIso(iso || util.todayIso());
    return ['mesh', kind, stamp].filter(Boolean).join('-') + '.' + (ext || 'csv');
  }

  /** Сохранение текста в файл (браузер). В Node вернёт false — вызывайте fs. */
  function downloadText(fileName, text, mime) {
    if (typeof document === 'undefined') return false;
    var blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return true;
  }

  return {
    pluralRu: pluralRu,
    mark: mark,
    markShort: markShort,
    delta: delta,
    trendArrow: trendArrow,
    percent: percent,
    dateRu: dateRu,
    dateShort: dateShort,
    dateDayMonth: dateDayMonth,
    weekdayShort: weekdayShort,
    monthName: monthName,
    dateRangeText: dateRangeText,
    relativeTime: relativeTime,
    studentsCount: studentsCount,
    lessonsCount: lessonsCount,
    marksCount: marksCount,
    truncate: truncate,
    csvCell: csvCell,
    toCsv: toCsv,
    toTextTable: toTextTable,
    exportFileName: exportFileName,
    downloadText: downloadText
  };
});
