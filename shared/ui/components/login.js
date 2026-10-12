/*!
 * Mesh Ranker — экран входа в МЭШ.
 *
 * Три способа войти (показываются в зависимости от платформы):
 *   1. «Войти через МЭШ» — встроенное окно входа (Electron) или WebView (Android),
 *      токен перехватывается автоматически после авторизации;
 *   2. вставка токена вручную (работает везде, включая web-режим);
 *   3. демо-режим — посмотреть интерфейс без аккаунта.
 *
 * После входа токен сохраняется нативным хранилищем платформы
 * (Electron — safeStorage/DPAPI, Android — приватные SharedPreferences),
 * а приложение дальше обновляет его автоматически.
 */
(function (root) {
  'use strict';

  var ui = root.MeshUI;
  var h = ui.h;
  var util = root.MeshLib.util;
  var MeshCore = root.MeshCore;

  function show(context) {
    var ctx = context || {};
    var platform = root.MeshPlatform;
    var host = ui.qs('#login-root');
    ui.clear(host);
    host.classList.add('login-visible');

    var status = h('div', { class: 'login-status' });
    var tokenInput = h('textarea', {
      class: 'input login-token',
      rows: 3,
      placeholder: 'Вставьте токен: eyJhbGciOi… или длинную строку из адресной строки',
      spellcheck: 'false'
    });
    var signInButton = ui.button({
      label: 'Войти по токену',
      kind: 'primary',
      icon: 'key',
      onClick: function () { submitToken(); }
    });
    var meshButton = ui.button({
      label: 'Войти через МЭШ',
      kind: 'primary',
      icon: 'lock',
      onClick: function () { startMeshLogin(); }
    });

    function setStatus(message, type) {
      ui.clear(status);
      if (!message) return;
      status.appendChild(ui.badge(message, type === 'error' ? 'red' : type === 'success' ? 'green' : type === 'warn' ? 'orange' : 'default'));
    }

    function setBusy(busy, label) {
      signInButton.disabled = busy;
      meshButton.disabled = busy;
      ui.clear(status);
      if (busy) status.appendChild(ui.spinner(label || 'Проверяем токен…'));
    }

    function finish(state) {
      host.classList.remove('login-visible');
      ui.clear(host);
      ui.toast('Вход выполнен: ' + (state && state.profile && state.profile.parent ? state.profile.parent.name : 'МЭШ'), { type: 'success' });
      if (ctx.onSuccess) ctx.onSuccess(state);
    }

    function handleError(error) {
      var message = error && error.message ? error.message : String(error);
      if (error && error.code === 'unauthorized' || (error && error.code === 'bad-token')) {
        message = 'МЭШ отклонил токен. Убедитесь, что скопировали его целиком и он ещё действует.';
      }
      setStatus(message, 'error');
      ui.toast('Не удалось войти', { type: 'error', detail: message });
    }

    function submitToken() {
      var raw = tokenInput.value;
      var token = MeshCore.extractToken(raw) || raw.trim();
      if (!token) return setStatus('Вставьте токен МЭШ', 'warn');
      setBusy(true);
      platform.signIn(token).then(finish).catch(function (error) {
        setBusy(false);
        handleError(error);
      });
    }

    function startMeshLogin() {
      setBusy(true, 'Открываем окно входа МЭШ…');
      platform.startMeshLogin().then(function (token) {
        if (!token) {
          setBusy(false);
          setStatus('Не удалось перехватить токен автоматически. Скопируйте его из открывшейся страницы и вставьте ниже.', 'warn');
          return;
        }
        setBusy(true, 'Токен получен, проверяем…');
        return platform.signIn(token).then(finish).catch(function (error) {
          setBusy(false);
          handleError(error);
        });
      }).catch(function (error) {
        setBusy(false);
        setStatus('Окно входа недоступно: ' + (error.message || error) + '. Вставьте токен вручную.', 'warn');
      });
    }

    function demoLogin() {
      setBusy(true, 'Загружаем демо-данные…');
      platform.demoToken().then(function (result) {
        return platform.signIn(result.token);
      }).then(finish).catch(function (error) {
        setBusy(false);
        handleError(error);
      });
    }

    var copyLink = ui.button({
      label: 'Скопировать ссылку',
      kind: 'ghost',
      icon: 'copy',
      onClick: function () {
        var url = MeshCore.loginUrl();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () { ui.toast('Ссылка скопирована', { type: 'success' }); });
        } else {
          ui.toast(url, { type: 'info', timeout: 12000 });
        }
      }
    });

    var steps = h('ol', { class: 'login-steps' }, [
      h('li', { class: 'login-step' }, [
        h('div', { class: 'login-step-body' }, [
          h('span', { text: 'Откройте страницу входа: ' }),
          h('code', { class: 'code', text: MeshCore.loginUrl() }),
          h('div', { class: 'login-step-actions' }, [copyLink])
        ])
      ]),
      h('li', { class: 'login-step' }, [h('div', { class: 'login-step-body', text: 'Войдите как родитель (роль 1, подсистема 2) — так МЭШ выдаёт токен, который читает этот рейтинг.' })]),
      h('li', { class: 'login-step' }, [h('div', { class: 'login-step-body', text: 'Страница покажет токен (JSON или длинную строку). Скопируйте его целиком — целиком важнее всего, токен можно вставлять и просто как текст страницы.' })]),
      h('li', { class: 'login-step' }, [h('div', { class: 'login-step-body', text: 'Вставьте токен в поле ниже и нажмите «Войти по токену». Дальше приложение всё делает само.' })]),
      h('li', { class: 'login-step' }, [h('div', { class: 'login-step-body', text: 'Токен сохранится на устройстве и будет автоматически обновляться — входить заново нужно только если МЭШ отзовёт сессию.' })])
    ]);

    var helpDetails = h('details', { class: 'login-help' }, [
      h('summary', { text: 'Где взять токен МЭШ? (инструкция)' }),
      steps
    ]);

    var storageNote = platform.mode === 'electron'
      ? 'Токен сохраняется через системное хранилище (DPAPI в Windows, libsecret/GNOME Keyring в Linux).'
      : platform.mode === 'android'
        ? 'Токен сохраняется в приватном хранилище приложения (SharedPreferences).'
        : 'Токен сохраняется на локальном сервере приложения в файле .preview/session.json (только ваш компьютер).';

    var actions = [ui.button({
      label: 'Обновить сохранённый токен',
      kind: 'ghost',
      icon: 'refresh',
      title: 'Попробовать обновить токен без повторного входа',
      onClick: function () {
        platform.state().then(function (state) {
          if (!state.authenticated) return setStatus('Сохранённого токена нет — нужен вход по токену', 'warn');
          setBusy(true, 'Обновляем токен…');
          return platform.refreshToken().then(function (next) {
            if (next && next.authenticated) return finish(next);
            setBusy(false);
            setStatus('МЭШ не выдал новый токен — войдите заново', 'error');
          });
        }).catch(function (error) { setBusy(false); handleError(error); });
      }
    })];

    var card = ui.card({
      className: 'login-card',
      title: 'Вход в МЭШ',
      subtitle: 'Рейтинг класса из school.mos.ru: вход один раз, дальше токен обновляется сам',
      body: [
        h('div', { class: 'login-hero' }, [
          h('div', { class: 'login-hero-text' }, [
            h('p', { text: 'Приложение работает только на чтение: оно забирает рейтинг класса, оценки, домашние задания и расписание вашего ребёнка.' }),
            h('p', { class: 'muted small', text: storageNote })
          ])
        ]),
        h('div', { class: 'login-actions' }, [meshButton]),
        h('div', { class: 'login-sep' }, [h('span', { text: 'или вставьте токен' })]),
        h('div', { class: 'login-token-row' }, [tokenInput, signInButton]),
        helpDetails,
        h('div', { class: 'login-actions' }, actions),
        ctx.demo ? h('div', { class: 'login-demo' }, [
          h('span', { class: 'muted small', text: 'Нет аккаунта под рукой? Можно посмотреть интерфейс на демо-данных:' }),
          ui.button({ label: 'Продолжить в демо-режиме', kind: 'ghost', icon: 'chart', onClick: demoLogin })
        ]) : null,
        status
      ]
    });

    host.appendChild(h('div', { class: 'login-wrap' }, [
      h('div', { class: 'login-brand' }, [
        h('span', { class: 'brand-mark', text: 'МЭШ' }),
        h('div', {}, [
          h('div', { class: 'brand-title', text: 'Mesh Ranker' }),
          h('div', { class: 'brand-sub', text: 'рейтинг класса, журнал, домашние задания' })
        ])
      ]),
      card,
      h('div', { class: 'login-foot muted small' }, [
        h('span', { text: 'Платформа: ' + platform.mode + ' · ' }),
        h('span', { text: 'Неофициальный клиент. Данные не покидают ваше устройство.' })
      ])
    ]));

    tokenInput.addEventListener('paste', function () {
      setTimeout(function () {
        var value = tokenInput.value;
        var token = MeshCore.extractToken(value);
        if (token && token !== value.trim()) {
          tokenInput.value = token;
          setStatus('Токен распознан и очищен от лишнего', 'success');
        }
      }, 30);
    });
    tokenInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submitToken();
    });

    if (!platform.isNative) {
      meshButton.disabled = true;
      meshButton.title = 'В web-режиме окно входа недоступно — используйте вставку токена';
    }
    setTimeout(function () { tokenInput.focus(); }, 60);
    return { setStatus: setStatus, hide: function () { host.classList.remove('login-visible'); ui.clear(host); } };
  }

  root.MeshUI = root.MeshUI || {};
  root.MeshUI.Login = { show: show };
})(typeof self !== 'undefined' ? self : this);
