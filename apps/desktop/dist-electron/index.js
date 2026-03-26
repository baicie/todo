let electron = require('electron');
let path = require('path');
let _electron_toolkit_utils = require('@electron-toolkit/utils');
//#region src/main/index.ts
function createWindow() {
  const mainWindow = new electron.BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux'
      ? { icon: (0, path.join)(__dirname, '../../build/icon.png') }
      : {}),
    webPreferences: {
      preload: (0, path.join)(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });
  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: 'deny' };
  });
  if (process.env['VITE_DEV_SERVER_URL']) mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL']);
  else mainWindow.loadFile((0, path.join)(__dirname, '../index.html'));
}
electron.app.whenReady().then(() => {
  _electron_toolkit_utils.electronApp.setAppUserModelId('com.electron');
  electron.app.on('browser-window-created', (_, window) => {
    _electron_toolkit_utils.optimizer.watchWindowShortcuts(window);
  });
  createWindow();
  electron.app.on('activate', function () {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') electron.app.quit();
});
//#endregion
