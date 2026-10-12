'use strict';
/*!
 * Mesh Ranker — встроенное окно входа в МЭШ.
 *
 * Механика: открываем страницу refresh-токена, а затем «вылавливаем» токен
 * из любых источников: адресной строки, localStorage, ответов fetch/XHR и
 * текста страницы. Сразу после этого окно закрывается, а токен уходит в
 * вызывающий код (и дальше — в защищённое хранилище).
 */

const path = require('path');
const { BrowserWindow, session } = require('electron');

function resolveCore() {
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'core', 'mesh-core.js'),
    path.join(__dirname, '..', '..', '..', 'shared', 'core', 'mesh-core.js')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Не найдено ядро mesh-core.js');
}

const MeshCore = resolveCore();
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Открывает окно входа и ждёт токен.
 * @returns {Promise<{token:string, source:string}>}
 */
function open(options) {
  const opts = options || {};
  const partition = opts.partition || 'persist:mesh-login';

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    let win = null;

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      ipcCleanup();
      if (win && !win.isDestroyed()) {
        win.removeAllListeners('closed');
        win.close();
      }
      if (error) reject(error); else resolve(result);
    };

    const handleCandidate = (text, source) => {
      if (settled || !text) return;
      const token = MeshCore.extractToken(text);
      if (!token) return;
      if (opts.onStatus) opts.onStatus('Токен получен (' + source + '), проверяем…');
      finish({ token, source });
    };

    const loginSession = session.fromPartition(partition);

    // Перехват сетевых ответов самого окна входа: МЭШ отдаёт токен в JSON
    loginSession.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      // сами запросы не читаем (тело недоступно), но фиксируем факт успешного входа
      if (details.url && /token|auth|session|login/i.test(details.url) && details.statusCode === 200) {
        if (opts.onStatus) opts.onStatus('МЭШ подтвердил авторизацию…');
      }
    });

    win = new BrowserWindow({
      parent: opts.parent,
      modal: false,
      width: 1024,
      height: 780,
      title: 'Вход в МЭШ',
      autoHideMenuBar: true,
      webPreferences: {
        partition: partition,
        preload: path.join(__dirname, 'login-preload.js'),
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        javascript: true
      }
    });

    // Сигналы из login-preload: url, storage, fetch, dom
    const onSignal = (event, payload) => {
      if (!payload) return;
      if (payload.kind === 'url') handleCandidate(payload.url, 'адрес');
      if (payload.text) handleCandidate(payload.text, payload.kind || 'данные');
      if (payload.value) handleCandidate(payload.value, 'localStorage:' + (payload.key || ''));
    };

    const ipcMain = require('electron').ipcMain;
    ipcMain.on('mesh:login-signal', onSignal);
    const ipcCleanup = () => ipcMain.removeListener('mesh:login-signal', onSignal);

    // Дополнительно опрашиваем страницу: localStorage и текст документа
    const poll = setInterval(async () => {
      if (settled || !win || win.isDestroyed()) return;
      try {
        const found = await win.webContents.executeJavaScript(`(() => {
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              const value = localStorage.getItem(key) || '';
              if (/token/i.test(key) || value.length > 24) return { kind: 'storage', key: key, value: value };
            }
          } catch (error) {}
          return { kind: 'dom', url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 20000) };
        })()`, true);
        if (found) {
          if (found.url) handleCandidate(found.url, 'адрес');
          if (found.value) handleCandidate(found.value, 'localStorage');
          if (found.text) handleCandidate(found.text, 'страница');
        }
      } catch (error) {
        // страница ещё грузится — не мешаем
      }
    }, 1200);

    win.webContents.on('did-navigate', (event, url) => handleCandidate(url, 'навигация'));
    win.webContents.on('did-navigate-in-page', (event, url) => handleCandidate(url, 'навигация'));
    win.webContents.on('did-finish-load', async () => {
      try {
        const url = win.webContents.getURL();
        handleCandidate(url, 'адрес');
        const text = await win.webContents.executeJavaScript('document.body ? document.body.innerText.slice(0, 30000) : ""', true);
        handleCandidate(text, 'страница');
      } catch (error) { /* игнорируем */ }
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      handleCandidate(url, 'новая вкладка');
      return { action: 'allow' };
    });

    win.on('closed', () => {
      clearInterval(poll);
      if (!settled) {
        settled = true;
        if (timeout) clearTimeout(timeout);
        ipcCleanup();
        reject(Object.assign(new Error('Окно входа закрыто без токена'), { code: 'login-cancelled' }));
      }
    });

    timeout = setTimeout(() => {
      finish(null, Object.assign(new Error('Время ожидания входа истекло'), { code: 'login-timeout' }));
    }, TIMEOUT_MS);

    win.loadURL(MeshCore.loginUrl());
  });
}

module.exports = { open };
