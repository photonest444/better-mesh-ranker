/*!
 * Mesh Ranker — UI-кит: DOM-помощники, карточки, модальные окна, тосты.
 */
(function (root) {
  'use strict';

  var lib = root.MeshLib || {};
  var util = lib.util;
  var format = lib.format;
  var stats = lib.stats;

  /** Гиперскрипт: h('div', {class:'x'}, [children]) */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class' || key === 'className') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'html') el.innerHTML = value;
        else if (key === 'dataset') Object.keys(value).forEach(function (k) { el.dataset[k] = value[k]; });
        else if (key === 'style' && typeof value === 'object') Object.keys(value).forEach(function (k) { el.style[k] = value[k]; });
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, value);
      });
    }
    append(el, children);
    return el;
  }

  function append(parent, children) {
    if (children === null || children === undefined || children === false) return parent;
    if (Array.isArray(children)) {
      children.forEach(function (child) { append(parent, child); });
      return parent;
    }
    parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
    return parent;
  }

  function frag(children) { return append(document.createDocumentFragment(), children); }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
  function qs(selector, rootEl) { return (rootEl || document).querySelector(selector); }
  function qsa(selector, rootEl) { return Array.prototype.slice.call((rootEl || document).querySelectorAll(selector)); }
  function icon(name) {
    var icons = {
      refresh: '⟳', search: '🔍', download: '⭳', close: '✕', check: '✓', warn: '⚠', info: 'ℹ',
      up: '▲', down: '▼', same: '=', star: '★', person: '👤', school: '🏫', clock: '🕒',
      chart: '📊', table: '▦', key: '🔑', lock: '🔒', logout: '⏏', sun: '☀', moon: '🌙',
      right: '›', left: '‹', plus: '＋', trash: '🗑', print: '🖨', copy: '⧉', book: '📘'
    };
    return icons[name] || '';
  }

  // --------------------------------------------------------------- тосты ----

  function toast(message, options) {
    var opts = options || {};
    var host = qs('#toasts');
    if (!host) return null;
    var node = h('div', { class: 'toast toast-' + (opts.type || 'info') }, [
      h('span', { class: 'toast-icon', text: opts.type === 'error' ? icon('warn') : opts.type === 'success' ? icon('check') : icon('info') }),
      h('div', { class: 'toast-body' }, [
        h('div', { class: 'toast-message', text: message }),
        opts.detail ? h('div', { class: 'toast-detail', text: opts.detail }) : null
      ]),
      opts.action ? h('button', { class: 'toast-action', text: opts.action.label, onclick: function () { opts.action.onClick(); node.remove(); } }) : null,
      h('button', { class: 'toast-close', text: icon('close'), onclick: function () { node.remove(); } })
    ]);
    host.appendChild(node);
    var timeout = opts.timeout === undefined ? (opts.type === 'error' ? 9000 : 4500) : opts.timeout;
    if (timeout > 0) setTimeout(function () { node.classList.add('toast-hide'); setTimeout(function () { node.remove(); }, 240); }, timeout);
    return node;
  }

  // -------------------------------------------------------------- модалки ----

  function modal(options) {
    var opts = options || {};
    var host = qs('#modal-root');
    var closed = false;
    var overlay = h('div', { class: 'modal-overlay' });
    var box = h('div', { class: 'modal modal-' + (opts.size || 'md') });
    var body = h('div', { class: 'modal-body' });
    var footer = h('div', { class: 'modal-footer' });
    append(body, opts.body);

    function close(result) {
      if (closed) return;
      closed = true;
      overlay.classList.add('modal-overlay-hide');
      setTimeout(function () { overlay.remove(); }, 160);
      if (typeof opts.onClose === 'function') opts.onClose(result);
    }

    var actions = (opts.actions || []).map(function (action) {
      return h('button', {
        class: 'btn ' + (action.kind || 'ghost'),
        text: action.label,
        disabled: action.disabled,
        onclick: function () {
          if (typeof action.onClick === 'function') {
            var result = action.onClick(api);
            if (result === false) return;
          }
          if (action.close !== false) close(action.value);
        }
      });
    });

    if (opts.title || opts.subtitle) {
      box.appendChild(h('div', { class: 'modal-head' }, [
        h('div', {}, [
          h('h2', { text: opts.title || '' }),
          opts.subtitle ? h('p', { class: 'muted', text: opts.subtitle }) : null
        ]),
        h('button', { class: 'icon-btn', text: icon('close'), title: 'Закрыть', onclick: function () { close(); } })
      ]));
    }
    box.appendChild(body);
    if (actions.length) footer.appendChild(frag(actions));
    box.appendChild(footer);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', function (event) { if (event.target === overlay) close(); });
    document.addEventListener('keydown', function onKey(event) {
      if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    host.appendChild(overlay);
    var focusable = box.querySelector('input, select, textarea, button');
    if (focusable) setTimeout(function () { focusable.focus(); }, 40);

    var api = { el: box, body: body, close: close, setBusy: function (busy) { box.classList.toggle('busy', !!busy); } };
    return api;
  }

  function confirmDialog(message, options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      modal({
        title: opts.title || 'Подтвердите действие',
        size: 'sm',
        body: h('p', { text: message }),
        actions: [
          { label: opts.cancelText || 'Отмена', kind: 'ghost', onClick: function () { resolve(false); } },
          { label: opts.okText || 'Да', kind: opts.danger ? 'danger' : 'primary', onClick: function () { resolve(true); } }
        ],
        onClose: function () { resolve(false); }
      });
    });
  }

  // -------------------------------------------------------------- карточки ----

  function card(options) {
    var opts = options || {};
    return h('section', { class: 'card ' + (opts.className || '') }, [
      (opts.title || opts.actions) ? h('header', { class: 'card-head' }, [
        h('div', {}, [
          opts.title ? h('h3', { text: opts.title }) : null,
          opts.subtitle ? h('p', { class: 'muted small', text: opts.subtitle }) : null
        ]),
        opts.actions ? h('div', { class: 'card-actions' }, opts.actions) : null
      ]) : null,
      h('div', { class: 'card-body' }, opts.body)
    ]);
  }

  /** KPI-плитка: значение, подпись, подсказка, цвет. */
  function stat(options) {
    var opts = options || {};
    return h('div', { class: 'stat stat-' + (opts.color || 'default') + (opts.onClick ? ' stat-clickable' : ''), onclick: opts.onClick }, [
      h('div', { class: 'stat-label', text: opts.label }),
      h('div', { class: 'stat-value' }, [
        h('span', { text: opts.value === null || opts.value === undefined ? '—' : opts.value }),
        opts.unit ? h('span', { class: 'stat-unit', text: opts.unit }) : null,
        opts.trend ? h('span', { class: 'stat-trend ' + (opts.trend > 0 ? 'up' : opts.trend < 0 ? 'down' : 'same'), text: format.trendArrow(opts.trend) }) : null
      ]),
      opts.hint ? h('div', { class: 'stat-hint', text: opts.hint }) : null
    ]);
  }

  function badge(text, kind, title) {
    return h('span', { class: 'badge badge-' + (kind || 'default'), title: title, text: text });
  }

  function bar(value, max, options) {
    var opts = options || {};
    var info = lib.table.bar(value, max, { color: opts.color });
    return h('div', { class: 'bar', title: opts.title || (format.markShort(value) + ' из ' + format.markShort(max)) }, [
      h('div', { class: 'bar-fill bar-' + info.color, style: { width: info.width + '%' } }),
      opts.label === false ? null : h('span', { class: 'bar-label', text: info.text })
    ]);
  }

  function spinner(label) {
    return h('div', { class: 'spinner-wrap' }, [
      h('div', { class: 'spinner' }),
      label ? h('span', { class: 'muted', text: label }) : null
    ]);
  }

  function skeleton(rows, cols) {
    var body = [];
    for (var r = 0; r < (rows || 5); r++) {
      var cells = [];
      for (var c = 0; c < (cols || 5); c++) cells.push(h('span', { class: 'skeleton-cell' }));
      body.push(h('div', { class: 'skeleton-row' }, cells));
    }
    return h('div', { class: 'skeleton' }, body);
  }

  function emptyState(options) {
    var opts = options || {};
    return h('div', { class: 'empty' }, [
      h('div', { class: 'empty-icon', text: opts.icon || icon('info') }),
      h('h4', { text: opts.title || 'Пока нет данных' }),
      opts.text ? h('p', { class: 'muted', text: opts.text }) : null,
      opts.action ? h('button', { class: 'btn primary', text: opts.action.label, onclick: opts.action.onClick }) : null
    ]);
  }

  // --------------------------------------------------------------- контролы ---

  function button(options) {
    var opts = options || {};
    return h('button', {
      class: 'btn ' + (opts.kind || 'ghost') + (opts.className ? ' ' + opts.className : ''),
      title: opts.title,
      disabled: opts.disabled,
      onclick: opts.onClick
    }, [
      opts.icon ? h('span', { class: 'btn-icon', text: icon(opts.icon) }) : null,
      opts.label ? h('span', { text: opts.label }) : null
    ]);
  }

  function field(options) {
    var opts = options || {};
    var control;
    if (opts.type === 'select') {
      control = h('select', { class: 'input', onchange: function (e) { opts.onChange && opts.onChange(e.target.value, e); } },
        (opts.options || []).map(function (option) {
          return h('option', { value: option.value, selected: String(option.value) === String(opts.value) }, option.label);
        }));
    } else if (opts.type === 'checkbox') {
      control = h('label', { class: 'checkbox' }, [
        h('input', { type: 'checkbox', checked: !!opts.value, onchange: function (e) { opts.onChange && opts.onChange(e.target.checked, e); } }),
        h('span', { text: opts.label })
      ]);
      return h('div', { class: 'field field-inline' }, [control, opts.hint ? h('span', { class: 'muted small', text: opts.hint }) : null]);
    } else {
      control = h('input', {
        class: 'input',
        type: opts.type || 'text',
        value: opts.value === undefined || opts.value === null ? '' : opts.value,
        placeholder: opts.placeholder,
        min: opts.min,
        max: opts.max,
        step: opts.step,
        onchange: function (e) { opts.onChange && opts.onChange(e.target.value, e); },
        oninput: opts.onInput ? function (e) { opts.onInput(e.target.value, e); } : undefined
      });
    }
    return h('label', { class: 'field ' + (opts.className || '') }, [
      opts.label ? h('span', { class: 'field-label', text: opts.label }) : null,
      control,
      opts.hint ? h('span', { class: 'muted small', text: opts.hint }) : null
    ]);
  }

  /** Кнопки-чипы для мультивыбора (предметы в рейтинге). */
  function chips(options) {
    var opts = options || {};
    var selected = new Set((opts.selected || []).map(String));
    var host = h('div', { class: 'chips' });
    var api = {
      el: host,
      selected: function () { return opts.multiple ? Array.from(selected) : (selected.size ? Array.from(selected)[0] : null); },
      set: function (values) {
        selected = new Set((values || []).map(String));
        rerender();
      }
    };
    function rerender() {
      clear(host);
      (opts.options || []).forEach(function (option) {
        var isActive = selected.has(String(option.value));
        host.appendChild(h('button', {
          class: 'chip' + (isActive ? ' chip-active' : '') + (option.color ? ' chip-' + option.color : ''),
          title: option.title,
          onclick: function () {
            var value = String(option.value);
            if (opts.multiple) {
              if (selected.has(value)) selected.delete(value); else selected.add(value);
            } else {
              selected.clear();
              selected.add(value);
            }
            rerender();
            if (opts.onChange) opts.onChange(api.selected());
          }
        }, [
          option.label,
          option.hint ? h('span', { class: 'chip-hint', text: option.hint }) : null
        ]));
      });
    }
    rerender();
    return api;
  }

  function toolbar(children) {
    return h('div', { class: 'toolbar' }, children);
  }

  /** Открывает диалог сохранения/скачивания текстового файла через платформу. */
  function saveTextFile(fileName, text, mime) {
    var platform = root.MeshPlatform;
    if (platform && platform.saveFile) return platform.saveFile(fileName, text, mime);
    format.downloadText(fileName, text, mime);
    return Promise.resolve(true);
  }

  root.MeshUI = {
    h: h,
    frag: frag,
    append: append,
    clear: clear,
    qs: qs,
    qsa: qsa,
    icon: icon,
    toast: toast,
    modal: modal,
    confirm: confirmDialog,
    card: card,
    stat: stat,
    badge: badge,
    bar: bar,
    spinner: spinner,
    skeleton: skeleton,
    empty: emptyState,
    button: button,
    field: field,
    chips: chips,
    toolbar: toolbar,
    saveTextFile: saveTextFile,
    stats: stats,
    util: util,
    format: format
  };
})(typeof self !== 'undefined' ? self : this);
