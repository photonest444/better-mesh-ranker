'use strict';
/*!
 * Mesh Ranker — точка входа Electron (Windows и Linux).
 *
 * Архитектура:
 *   main process  — окна, меню, IPC, хранилище токена, все сетевые запросы (MeshService);
 *   preload       — узкий мост contextBridge (window.meshDesktop);
 *   renderer      — интерфейс из shared/ui (тот же, что в Android-версии).
 *
 * Окно входа в МЭШ — отдельный BrowserWindow: после авторизации токен
 * перехватывается из URL, localStorage и ответов сети, а затем сохраняется
 * в защищённом хранилище ОС.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, nativeTheme } = require('electron');

const { MeshService, MeshCore } = require('./mesh-service');
const { SessionStore } = require('./mesh-store');
const meshLoginWindow = require('./login-window');

const IS_DEV = process.argv.includes('--dev');
const IS_DEMO = process.argv.includes('--demo') || process.env.MESH_DEMO === '1';

let mainWindow = null;
let service = null;

// ------------------------------------------------------------------ ресурсы ---

/** Каталог интерфейса: сначала собранная копия, затем рабочий каталог репозитория. */
function resolveUiRoot() {
  const candidates = [
    path.join(__dirname, '..', 'renderer'),
    path.join(__dirname, '..', '..', '..', 'shared', 'ui')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  throw new Error('Не найден интерфейс (shared/ui)');
}

function resolveIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(__dirname, '..', '..', '..', 'shared', 'ui', 'favicon.png')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// -------------------------------------------------------------------- окно ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10131a' : '#f3f5f9',
    title: 'Mesh Ranker — рейтинг класса МЭШ',
    icon: resolveIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.loadFile(path.join(resolveUiRoot(), 'index.html'));

  // Внешние ссылки — в системный браузер
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// -------------------------------------------------------------------- IPC ----

function sendEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('meshDesktop:event', { channel, payload });
  }
}

/** Оборачивает результат/ошибку в единый конверт ответа. */
async function wrap(promise) {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    const isMeshError = error && error.name === 'MeshError';
    return {
      ok: false,
      error: {
        code: error && error.code ? error.code : 'error',
        message: isMeshError ? MeshCore.describeError(error) : ((error && error.message) || String(error)),
        raw: error && error.message ? String(error.message) : String(error)
      }
    };
  }
}

function registerIpc() {
  ipcMain.handle('mesh:invoke', async (event, request) => {
    const { method, payload } = request || {};
    return wrap(service.handle(method, payload));
  });

  ipcMain.handle('mesh:open-external', (event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  /** Встроенное окно входа в МЭШ: возвращает перехваченный токен. */
  ipcMain.handle('mesh:login', async () => {
    return wrap(meshLoginWindow.open({
      parent: mainWindow,
      partition: 'persist:mesh-login',
      onStatus: (message) => sendEvent('status', { message, type: 'info' })
    }));
  });

  /** Сохранение файла (экспорт CSV/JSON) через системный диалог. */
  ipcMain.handle('mesh:save-file', async (event, request) => {
    const { fileName, text } = request || {};
    const defaultPath = path.join(app.getPath('downloads'), fileName || 'mesh-export.csv');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Сохранить файл',
      defaultPath,
      filters: [
        { name: 'Таблицы CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, text === undefined ? '' : String(text), 'utf8');
    return { saved: true, filePath: result.filePath };
  });
}

// -------------------------------------------------------------------- меню ---

function buildMenu() {
  const template = [
    {
      label: 'Файл',
      submenu: [
        {
          label: 'Обновить данные',
          accelerator: 'CmdOrCtrl+R',
          click: () => sendEvent('status', { message: 'Обновляем данные…', type: 'info' }) || mainWindow.webContents.reload()
        },
        {
          label: 'Экспорт текущей таблицы…',
          click: () => sendEvent('command', { name: 'export' })
        },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' }
      ]
    },
    {
      label: 'МЭШ',
      submenu: [
        { label: 'Войти заново…', click: () => sendEvent('command', { name: 'login' }) },
        {
          label: 'Обновить токен',
          click: async () => {
            const result = await wrap(service.refreshToken());
            sendEvent('status', result.ok
              ? { message: 'Токен обновлён', type: 'success' }
              : { message: result.error.message, type: 'error' });
          }
        },
        { label: 'Открыть school.mos.ru', click: () => shell.openExternal('https://school.mos.ru') },
        { type: 'separator' },
        { label: 'Выйти из аккаунта', click: () => { service.signOut(); sendEvent('state', service.state()); } }
      ]
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'О программе',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Mesh Ranker',
              message: 'Mesh Ranker ' + app.getVersion(),
              detail: [
                'Рейтинг класса, оценки, домашние задания и расписание МЭШ.',
                '',
                'Электронный дневник: school.mos.ru',
                'Хранилище токена: ' + (service.store.canEncrypt() ? 'шифрование средствами ОС' : 'файл в каталоге профиля'),
                'Демо-режим: ' + (IS_DEMO ? 'включён' : 'выключен'),
                '',
                'Неофициальный клиент, MIT.'
              ].join('\n')
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------- старт ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('ru.mesh.ranker');

    service = new MeshService({
      dir: app.getPath('userData'),
      safeStorage: safeStorage,
      demo: IS_DEMO
    });
    service.on('token', (payload) => sendEvent('token', payload));
    service.on('state', (state) => sendEvent('state', state));

    await service.init();

    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (service) service.dispose();
  });
}
