'use strict';
/*!
 * Mesh Ranker — preload основного окна.
 *
 * Открывает интерфейсу ровно один канал — window.meshDesktop — и ничего больше.
 * Никакого require, fs или сети в renderer-процессе нет: всё общение идёт
 * через IPC к главному процессу.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meshDesktop', {
  /** Вызов метода ядра: invoke('rank', {...}) → Promise<данные>. */
  invoke(method, payload) {
    if (method === 'saveFile') {
      return ipcRenderer.invoke('mesh:save-file', payload || {});
    }
    if (method === 'startMeshLogin') {
      return ipcRenderer.invoke('mesh:login');
    }
    if (method === 'settings') {
      return ipcRenderer.invoke('mesh:invoke', { method: 'settingsGet', payload: payload || {} });
    }
    if (method === 'openExternal') {
      return ipcRenderer.invoke('mesh:open-external', payload && payload.url);
    }
    return ipcRenderer.invoke('mesh:invoke', { method, payload: payload || {} });
  },

  /** Подписка на события главного процесса: state | token | status | command. */
  on(channel, handler) {
    const listener = (event, message) => {
      if (!message || message.channel !== channel) return;
      try { handler(message.payload); } catch (error) { console.error(error); }
    };
    ipcRenderer.on('meshDesktop:event', listener);
    return () => ipcRenderer.removeListener('meshDesktop:event', listener);
  },

  /** Метаданные окружения — показываются в «О приложении». */
  info: {
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  },

  openExternal(url) {
    return ipcRenderer.invoke('mesh:open-external', url);
  },

  quit() {
    return ipcRenderer.invoke('mesh:invoke', { method: 'quit', payload: {} });
  }
});
