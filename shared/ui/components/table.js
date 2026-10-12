/*!
 * Mesh Ranker — переиспользуемая таблица данных.
 *
 * Умеет: сортировку по клику на заголовок, поиск, фильтры-селекты,
 * постраничный вывод, строку итогов, подсветку строки ученика и экспорт в CSV.
 *
 *   const table = MeshUI.DataTable(host, { columns: [...], rows: [...] });
 *   table.setRows(newRows);
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var util = root.MeshLib.util;
  var format = root.MeshLib.format;
  var tableLib = root.MeshLib.table;
  var h = ui.h;

  function defaultRender(column, row) {
    var value = tableLib.valueOf(row, column);
    if (column.render) return column.render(row, value);
    if (value === null || value === undefined || value === '') return '—';
    if (column.type === 'number') return format.markShort(value);
    if (column.type === 'date') return format.dateShort(value);
    if (column.type === 'boolean') return util.asBool(value) ? '✓' : '—';
    return String(value);
  }

  /**
   * @param {HTMLElement} host контейнер, куда рендерится таблица
   * @param {object} config см. описание в шапке файла
   */
  function DataTable(host, config) {
    var cfg = config || {};
    var columns = cfg.columns || [];
    var state = {
      rows: cfg.rows || [],
      sort: cfg.sort || null,
      query: '',
      filters: {},
      page: 1,
      pageSize: cfg.pageSize === undefined ? 25 : cfg.pageSize,
      loading: false
    };

    var toolbarHost = h('div', { class: 'table-toolbar' });
    var tableHost = h('div', { class: 'table-scroll' });
    var footerHost = h('div', { class: 'table-footer' });
    var root = h('div', { class: 'data-table' }, [toolbarHost, tableHost, footerHost]);
    host.appendChild(root);

    function visibleRows() {
      var rows = state.rows.slice();
      if (cfg.search && cfg.search.enabled !== false && state.query) {
        rows = tableLib.filterRows(rows, state.query, { keys: cfg.search.keys || columns.map(function (c) { return c.key; }) });
      }
      Object.keys(state.filters).forEach(function (key) {
        var wanted = state.filters[key];
        if (wanted === 'all' || wanted === '' || wanted === undefined) return;
        var filter = (cfg.filters || []).filter(function (f) { return f.key === key; })[0];
        if (!filter) return;
        var valueOf = filter.value || function (row) { return util.deepGet(row, key, null); };
        rows = rows.filter(function (row) { return util.asStr(valueOf(row)) === util.asStr(wanted); });
      });
      if (state.sort) rows = tableLib.sortRows(rows, state.sort);
      return rows;
    }

    function renderToolbar(rows) {
      ui.clear(toolbarHost);
      var left = [];
      var right = [];

      if (cfg.search && cfg.search.enabled !== false) {
        var input = h('input', {
          class: 'input input-search',
          type: 'search',
          placeholder: cfg.search.placeholder || 'Поиск по таблице…',
          value: state.query,
          oninput: function (event) {
            state.query = event.target.value;
            state.page = 1;
            renderBody();
          }
        });
        left.push(h('div', { class: 'search-box' }, [h('span', { class: 'search-icon', text: ui.icon('search') }), input]));
      }

      (cfg.filters || []).forEach(function (filter) {
        var options = [{ value: 'all', label: filter.label + ': все' }];
        (filter.options || []).forEach(function (option) { options.push(option); });
        left.push(ui.field({
          type: 'select',
          value: state.filters[filter.key] || 'all',
          options: options,
          className: 'field-compact',
          onChange: function (value) {
            state.filters[filter.key] = value;
            state.page = 1;
            renderBody();
          }
        }));
      });

      left.push(h('span', { class: 'muted small table-count', text: format.pluralRu(rows.length, 'строка', 'строки', 'строк') + ': ' + rows.length }));

      if (cfg.exportName !== false) {
        right.push(ui.button({ label: 'CSV', kind: 'ghost', icon: 'download', title: 'Экспорт таблицы в CSV', onClick: exportCsv }));
        if (cfg.onExportText !== false) {
          right.push(ui.button({ label: 'Копировать', kind: 'ghost', icon: 'copy', title: 'Скопировать таблицу текстом', onClick: copyAsText }));
        }
      }

      if (left.length) toolbarHost.appendChild(h('div', { class: 'toolbar-left' }, left));
      if (right.length) toolbarHost.appendChild(h('div', { class: 'toolbar-right' }, right));
    }

    function renderHead() {
      var headRow = h('tr', {}, columns.map(function (column) {
        var sortable = column.sortable !== false;
        var isSorted = state.sort && state.sort.key === column.key;
        return h('th', {
          class: 'col-' + (column.type || 'text') + (sortable ? ' sortable' : '') + (isSorted ? ' sorted-' + state.sort.dir : '') +
            (column.align ? ' align-' + column.align : ''),
          style: column.width ? { width: column.width } : null,
          title: column.hint || ('Сортировать по «' + (column.title || column.key) + '»'),
          onclick: sortable ? function () {
            if (state.sort && state.sort.key === column.key) {
              state.sort = { key: column.key, dir: state.sort.dir === 'desc' ? 'asc' : 'desc', type: column.type, value: column.value };
            } else {
              state.sort = { key: column.key, dir: column.defaultDir || (column.type === 'number' ? 'desc' : 'asc'), type: column.type, value: column.value };
            }
            state.page = 1;
            renderAll();
          } : null
        }, [
          h('span', { text: column.title || column.key }),
          isSorted ? h('span', { class: 'sort-arrow', text: state.sort.dir === 'desc' ? '▾' : '▴' }) : null
        ]);
      }));
      return h('thead', {}, headRow);
    }

    function renderRow(row, index) {
      var cls = [index % 2 ? 'row-odd' : 'row-even'];
      if (cfg.rowClass) cls.push(cfg.rowClass(row, index));
      if (cfg.highlight && cfg.highlight(row)) cls.push('row-highlight');
      return h('tr', {
        class: cls.join(' '),
        onclick: cfg.onRowClick ? function () { cfg.onRowClick(row, index); } : null
      }, columns.map(function (column) {
        var content = defaultRender(column, row);
        return h('td', {
          class: 'col-' + (column.type || 'text') + (column.align ? ' align-' + column.align : ''),
          title: column.cellTitle ? column.cellTitle(row) : (typeof content === 'string' ? content : '')
        }, content);
      }));
    }

    function renderBody() {
      var rows = visibleRows();
      var page = state.pageSize ? tableLib.paginate(rows, state.page, state.pageSize) : null;
      var pageRows = page ? page.rows : rows;

      ui.clear(tableHost);
      if (state.loading) {
        tableHost.appendChild(ui.skeleton(Math.min(8, state.pageSize || 8), Math.min(6, columns.length)));
      } else if (!rows.length) {
        tableHost.appendChild(ui.empty(cfg.empty || { title: 'Нет данных', text: 'Измените фильтры или период.' }));
      } else {
        var tbody = h('tbody', {}, pageRows.map(function (row, index) { return renderRow(row, index); }));
        tableHost.appendChild(h('table', { class: 'table' }, [renderHead(), tbody]));
      }

      ui.clear(footerHost);
      if (page && page.pages > 1) {
        footerHost.appendChild(h('div', { class: 'pager' }, [
          ui.button({ label: '‹', kind: 'ghost', disabled: page.page <= 1, onClick: function () { state.page = page.page - 1; renderBody(); } }),
          h('span', { class: 'muted', text: 'Стр. ' + page.page + ' из ' + page.pages + ' (' + page.from + '–' + page.to + ' из ' + page.total + ')' }),
          ui.button({ label: '›', kind: 'ghost', disabled: page.page >= page.pages, onClick: function () { state.page = page.page + 1; renderBody(); } })
        ]));
      } else if (rows.length) {
        footerHost.appendChild(h('div', { class: 'muted small', text: 'Показано ' + rows.length + ' ' + format.pluralRu(rows.length, 'строка', 'строки', 'строк') }));
      }

      if (cfg.showSummary) {
        var summary = tableLib.summarize(rows, columns.filter(function (c) { return c.summary; }));
        var keys = Object.keys(summary);
        if (keys.length) {
          footerHost.appendChild(h('div', { class: 'table-summary' }, keys.map(function (key) {
            var column = columns.filter(function (c) { return c.key === key; })[0] || { title: key };
            var data = summary[key];
            return h('span', { class: 'summary-item' }, [
              h('b', { text: column.title || key }),
              h('span', { text: ' средняя ' + format.markShort(data.mean) }),
              h('span', { text: ', медиана ' + format.markShort(data.median) }),
              h('span', { text: ', мин ' + format.markShort(data.min) + ' / макс ' + format.markShort(data.max) })
            ]);
          })));
        }
      }
    }

    function renderAll() {
      var rows = visibleRows();
      renderToolbar(rows);
      renderBody();
    }

    function exportRows() {
      return state.sort || state.query || Object.keys(state.filters).length ? visibleRows() : state.rows;
    }

    function exportCsv() {
      var exportColumns = columns.filter(function (column) { return column.export !== false; }).map(function (column) {
        return {
          key: column.key,
          title: column.title || column.key,
          value: column.exportValue || column.value || function (row) {
            var value = tableLib.valueOf(row, column);
            if (column.type === 'date') return format.dateShort(value);
            if (column.type === 'number') return value === null || value === undefined ? '' : String(value).replace('.', ',');
            if (column.type === 'boolean') return util.asBool(value) ? 'да' : 'нет';
            return value;
          }
        };
      });
      var csv = format.toCsv(exportRows(), exportColumns, { title: cfg.exportTitle });
      var fileName = format.exportFileName(cfg.exportName || 'table', cfg.exportDate || util.todayIso(), 'csv');
      return ui.saveTextFile(fileName, csv, 'text/csv').then(function () {
        ui.toast('Файл сохранён: ' + fileName, { type: 'success' });
        return fileName;
      });
    }

    function copyAsText() {
      var exportColumns = columns.filter(function (column) { return column.export !== false; });
      var text = format.toTextTable(exportRows(), exportColumns.map(function (column) {
        return { key: column.key, title: column.title || column.key, value: column.value || function (row) { return tableLib.valueOf(row, column); } };
      }));
      var done = function () { ui.toast('Таблица скопирована в буфер обмена', { type: 'success' }); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(done, function () { ui.toast('Не удалось скопировать', { type: 'error' }); });
      }
      ui.toast('Буфер обмена недоступен', { type: 'warn' });
      return null;
    }

    var api = {
      el: root,
      setRows: function (rows) {
        state.rows = rows || [];
        state.page = 1;
        state.loading = false;
        renderAll();
        return api;
      },
      setLoading: function (loading) {
        state.loading = !!loading;
        renderBody();
        return api;
      },
      setError: function (message) {
        state.loading = false;
        ui.clear(tableHost);
        tableHost.appendChild(ui.empty({ title: 'Ошибка загрузки', text: message, icon: ui.icon('warn') }));
        return api;
      },
      refresh: function () { renderAll(); return api; },
      getRows: function () { return state.rows.slice(); },
      getVisibleRows: function () { return visibleRows(); },
      setQuery: function (query) { state.query = query || ''; renderAll(); return api; },
      focusSearch: function () {
        var input = toolbarHost.querySelector('input[type="search"]');
        if (input) input.focus();
        return api;
      },
      exportCsv: exportCsv,
      destroy: function () { root.remove(); }
    };

    renderAll();
    return api;
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.DataTable = DataTable;
})(typeof self !== 'undefined' ? self : this);
