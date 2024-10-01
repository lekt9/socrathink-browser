import { autoUpdater } from 'electron-updater';
import { ipcMain, dialog, app } from 'electron';
import { Application } from '../application';

export const runAutoUpdaterService = () => {
  let updateAvailable = false;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'The-Clarity-Projekt',
    repo: 'socrathink-browser',
  });

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
      console.log('Checking for updates...');
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (e) {
      console.error(e);
      showUpdateDialog('Error', 'An error occurred while checking for updates.');
    }
  });

  autoUpdater.on('update-not-available', () => {
  });

  autoUpdater.on('update-available', () => {
    showUpdateDialog('Update Available', 'A new version of Socrathink Browser is available. It will be downloaded automatically.');
  });

  autoUpdater.on('update-downloaded', () => {
    updateAvailable = true;

    for (const window of Application.instance.windows.list) {
      window.send('update-available');
      Application.instance.dialogs
        .getDynamic('menu')
        ?.browserView?.webContents?.send('update-available');
    }

    showUpdateDialog('Update Ready', 'A new version of Socrathink Browser has been downloaded. Would you like to install it now?', true);
  });

  autoUpdater.on('error', (err) => {
    showUpdateDialog('Update Error', `An error occurred while updating: ${err.message}`);
  });
};

function showUpdateDialog(title: string, message: string, showInstallOption: boolean = false) {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    buttons: showInstallOption ? ['Install Now', 'Later'] : ['OK'],
    title: title,
    message: message,
  };

  dialog.showMessageBox(options).then((result) => {
    if (showInstallOption && result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
}
