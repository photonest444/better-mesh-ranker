'use strict';
/*!
 * Mesh Ranker — preload окна входа в МЭШ.
 *
 * Задача — как можно раньше заметить токен: перехватываем запись в
 * localStorage, ответы fetch/XHR и изменения адреса, а найденные значения
 * отправляем в главный процесс (он решает, токен это или нет).
 *
 * Окно входа изолировано отдельной сессией (partition), поэтому этот скрипт
 * не имеет доступа к интерфейсу приложения.
 */

const { ipcRenderer } = require('electron');

let reported = 0;
const MAX_REPORTS = 400;

function report(kind, payload) {
  if (reported++ > MAX_REPORTS) return;
  try {
    ipcRenderer.send('mesh:login-signal', Object.assign({ kind }, payload || {}));
  } catch (error) { /* главный процесс закрыт */ }
}

// --- адрес страницы -------------------------------------------------------
function reportUrl() {
  report('url', { url: location.href });
}

window.addEventListener('load', () => {
  reportUrl();
  report('dom', { url: location.href, text: document.body ? document.body.innerText.slice(0, 30000) : '' });
});
window.addEventListener('popstate', reportUrl);
window.addEventListener('hashchange', reportUrl);
setInterval(reportUrl, 2000);

// --- localStorage ---------------------------------------------------------
try {
  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function setItem(key, value) {
    const result = originalSetItem.apply(this, arguments);
    try {
      if (value !== undefined && value !== null) report('storage', { key: String(key), value: String(value) });
    } catch (error) { /* игнорируем */ }
    return result;
  };
} catch (error) { /* страница может блокировать */ }

// --- fetch ----------------------------------------------------------------
try {
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function meshFetch(input, init) {
      return originalFetch.apply(this, arguments).then((response) => {
        try {
          const url = (response && response.url) || String(input);
          if (/token|auth|session|login|profile/i.test(url)) {
            response.clone().text().then((text) => report('fetch', { url, text: text.slice(0, 20000) })).catch(() => {});
          }
        } catch (error) { /* игнорируем */ }
        return response;
      });
    };
  }
} catch (error) { /* игнорируем */ }

// --- XMLHttpRequest -------------------------------------------------------
try {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function open(method, url) {
    this.__meshUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function send() {
    this.addEventListener('load', () => {
      try {
        if (/token|auth|session|login|profile/i.test(String(this.__meshUrl || ''))) {
          report('xhr', { url: String(this.__meshUrl || ''), text: String(this.responseText || '').slice(0, 20000) });
        }
      } catch (error) { /* игнорируем */ }
    });
    return originalSend.apply(this, arguments);
  };
} catch (error) { /* игнорируем */ }
