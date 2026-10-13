/*!
 * Mesh Ranker — палитра команд (Ctrl+K).
 *
 * Одна строка, чтобы попасть куда угодно: вкладки, предметы (открывают
 * рейтинг по предмету), ученики, быстрые действия (обновить, снимок, экспорт,
 * выход). Поиск и ранжирование совпадений — в общем ядре
 * (`MeshLib.insights.searchItems`), поэтому поведение одинаково в web,
 * Electron и Android.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var util = ui.util;
  var lib = root.MeshLib;
  var insights = lib.insights;

  var overlay = null;
  var input = null;
  var listHost = null;
  var items = [];
  var results = [];
  var active = 0;
  var context = null;
  var subjectsLoaded = false;

  function views() {
    return (root.MeshUI.views) || {};
  }

  function collectItems() {
    var collected = [];
    var state = (context && context.state && context.state()) || {};
    var student = (context && context.student && context.student()) || null;

    Object.keys(views()).forEach(function (id) {
      var view = views()[id];
      collected.push({
        id: 'view:' + id,
        title: view.title || id,
        subtitle: view.hint || 'Вкладка',
        group: 'view',
        keywords: id,
        icon: 'right',
        run: function () { root.MeshApp.go(id); }
      });
    });

    collected.push({
      id: 'action:refresh',
      title: 'Обновить данные',
      subtitle: 'Перезагрузить состояние и текущую вкладку',
      group: 'action',
      keywords: 'refresh обновить перезагрузка',
      icon: 'refresh',
      run: function () { root.MeshApp.refresh(true); }
    });
    collected.push({
      id: 'action:snapshot',
      title: 'Сохранить снимок динамики',
      subtitle: 'Запомнить место и средний балл на дату',
      group: 'action',
      keywords: 'снимок история динамика snapshot',
      icon: 'star',
      run: function () { root.MeshApp.go('insights'); }
    });
    collected.push({
      id: 'action:export',
      title: 'Экспорт данных',
      subtitle: 'CSV текущей вкладки',
      group: 'action',
      keywords: 'экспорт csv выгрузка файл',
      icon: 'download',
      run: function () {
        var flow = document.querySelector('.data-table .toolbar-right button');
        if (flow) flow.click();
        else ui.toast('На этой вкладке нет таблицы для экспорта', { type: 'warn' });
      }
    });
    collected.push({
      id: 'action:settings',
      title: 'Настройки',
      subtitle: 'Тема, размер страниц, движок расчётов',
      group: 'action',
      keywords: 'настройки settings тема',
      icon: 'settings',
      run: function () { root.MeshApp.go('settings'); }
    });
    collected.push({
      id: 'action:signout',
      title: 'Выйти из МЭШ',
      subtitle: 'Завершить сессию на этом устройстве',
      group: 'action',
      keywords: 'выход выйти signout logout',
      icon: 'close',
      run: function () {
        if (root.MeshApp && root.MeshApp.onSignedOut) root.MeshPlatform.signOut().then(root.MeshApp.onSignedOut);
      }
    });

    ((state && state.children) || []).forEach(function (child) {
      collected.push({
        id: 'student:' + child.id,
        title: child.name || child.shortName || 'Ученик',
        subtitle: (child.className ? child.className + ' · ' : '') + 'сменить ученика',
        group: 'student',
        keywords: 'ученик ребёнок student ' + (child.className || ''),
        icon: 'user',
        run: function () { root.MeshApp.switchStudent(child.id); }
      });
    });

    if (student) {
      collected.push({
        id: 'action:profile',
        title: 'Профиль: ' + (student.name || 'ученик'),
        subtitle: 'Класс, школа, аккаунт',
        group: 'action',
        keywords: 'профиль аккаунт',
        icon: 'user',
        run: function () { root.MeshApp.go('profile'); }
      });
    }

    return collected;
  }

  function loadSubjects() {
    if (subjectsLoaded || !context) return;
    var student = context.student && context.student();
    if (!student) return;
    subjectsLoaded = true;
    root.MeshPlatform.subjects({ studentId: student.id, date: root.MeshApp ? root.MeshApp.date : util.todayIso() })
      .then(function (result) {
        var subjects = (result && result.subjects) || [];
        subjects.forEach(function (subject) {
          items.push({
            id: 'subject:' + subject.id,
            title: subject.name,
            subtitle: 'Рейтинг по предмету',
            group: 'subject',
            keywords: 'предмет рейтинг ' + subject.id,
            icon: 'chart',
            run: function () {
              root.MeshApp.go('ranking');
              var ranking = root.MeshApp.instances.ranking;
              if (ranking && ranking.selectSubject) ranking.selectSubject(subject.id);
              else if (ranking && ranking.refresh) ranking.refresh();
            }
          });
        });
      })
      .catch(function () { subjectsLoaded = true; });
  }

  function render() {
    ui.clear(listHost);
    if (!results.length) {
      listHost.appendChild(h('div', { class: 'palette-empty muted', text: input.value ? 'Ничего не найдено' : 'Начните вводить: рейтинг, предмет, ученик, экспорт…' }));
      return;
    }
    results.forEach(function (item, index) {
      listHost.appendChild(h('button', {
        class: 'palette-item' + (index === active ? ' palette-active' : ''),
        onclick: function () { run(item); },
        onmouseenter: function () { active = index; render(); }
      }, [
        h('span', { class: 'palette-icon', text: ui.icon(item.icon || 'info') }),
        h('div', { class: 'palette-text' }, [
          h('div', { class: 'palette-title', text: item.title }),
          item.subtitle ? h('div', { class: 'palette-subtitle muted small', text: item.subtitle }) : null
        ]),
        h('span', { class: 'palette-group muted small', text: GROUP_LABELS[item.group] || item.group })
      ]));
    });
    var node = listHost.querySelector('.palette-active');
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
  }

  var GROUP_LABELS = {
    view: 'вкладка',
    subject: 'предмет',
    student: 'ученик',
    action: 'действие'
  };

  function search(query) {
    results = insights.searchItems(items, query, { limit: 12 });
    active = 0;
    render();
  }

  function run(item) {
    close();
    if (item && typeof item.run === 'function') item.run();
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(active + 1, results.length - 1);
      render();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(active - 1, 0);
      render();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (results[active]) run(results[active]);
    }
  }

  function open(ctx) {
    if (overlay) return overlay;
    context = ctx || context;
    items = collectItems();
    subjectsLoaded = false;
    loadSubjects();

    input = h('input', {
      class: 'palette-input',
      type: 'text',
      placeholder: 'Поиск: вкладка, предмет, ученик, действие…',
      oninput: function (event) { search(event.target.value); }
    });
    listHost = h('div', { class: 'palette-list' });
    overlay = h('div', { class: 'palette-overlay', onmousedown: function (event) { if (event.target === overlay) close(); } }, [
      h('div', { class: 'palette' }, [
        h('div', { class: 'palette-head' }, [h('span', { class: 'palette-icon', text: ui.icon('search') }), input, h('kbd', { class: 'palette-kbd', text: 'Esc' })]),
        listHost,
        h('div', { class: 'palette-foot muted small' }, [
          h('kbd', { class: 'palette-kbd', text: '↑↓' }), ' выбор  ',
          h('kbd', { class: 'palette-kbd', text: 'Enter' }), ' открыть'
        ])
      ])
    ]);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    search('');
    setTimeout(function () { input.focus(); }, 30);
    return overlay;
  }

  function close() {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
    input = null;
    listHost = null;
    results = [];
  }

  function toggle(ctx) {
    if (overlay) close();
    else open(ctx);
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.palette = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function () { return !!overlay; },
    search: insights.searchItems,
    collect: collectItems
  };
})(typeof self !== 'undefined' ? self : this);
