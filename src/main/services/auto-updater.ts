import { autoUpdater } from 'electron-updater';
import { ipcMain } from 'electron';
import { Application } from '../application';

export const runAutoUpdaterService = () => {
  let updateAvailable = false;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'The-Clarity-Projekt',
    repo: 'socrathink-browser',
  })
  ipcMain.on('install-update', () => {
    if (process.env.NODE_ENV !== 'development') {
      autoUpdater.quitAndInstall(true, true);
    }
  });

  ipcMain.handle('is-update-available', () => {
    return updateAvailable;
  });

  ipcMain.on('update-check', async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      console.error(e);
    }
  });

  autoUpdater.on('update-downloaded', () => {
    updateAvailable = true;

    for (const window of Application.instance.windows.list) {
      window.send('update-available');
      Application.instance.dialogs
        .getDynamic('menu')
        ?.browserView?.webContents?.send('update-available');
    }
  });
};
