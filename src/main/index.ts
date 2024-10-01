import { lookup } from 'mime-types';
import { extname } from 'path';
// @index.ts

import { ipcMain, app, protocol, webContents, session, BrowserWindow, BrowserView } from 'electron';
import { setIpcMain } from '@wexond/rpc-electron';
setIpcMain(ipcMain);
import * as fs from 'fs';
import * as path from 'path';

import { v4 as uuidv4 } from 'uuid';
import { platform } from 'os';
import { Application } from './application';

import { setupNetworkHandlers, addNetworkLog, sendNetworkLogToRenderers } from './network';
import { parseMarkdown } from '~/utils/parse';

import { ContextService } from './services/context';

require('@electron/remote/main').initialize();

if (process.env.NODE_ENV === 'development') {
  require('source-map-support').install();
}

export const isNightly = app.name === 'socrathink-nightly';

app.name = isNightly ? 'socrathink Nightly' : 'socrathink';

(process.env as any)['ELECTRON_DISABLE_SECURITY_WARNINGS'] = true;

app.commandLine.appendSwitch('--enable-transparent-visuals');
app.commandLine.appendSwitch(
  'enable-features',
  'CSSColorSchemeUARendering, ImpulseScrollAnimations, ParallelDownloading',
);


app.commandLine.appendSwitch('remote-debugging-port', '9222');

const MAX_LISTENERS = 25; // Choose an appropriate number based on your needs
ipcMain.setMaxListeners(MAX_LISTENERS);

const application = Application.instance;
app.once('ready', async () => {
  await application.start();

  new ContextService();

  setupNetworkHandlers();
});
process.on('uncaughtException', (error) => {
  console.error(error);
});

app.on('window-all-closed', () => {
  if (platform() !== 'darwin') {
    app.quit();
  }
});

ipcMain.on('get-webcontents-id', (e) => {
  e.returnValue = e.sender.id;
});

ipcMain.on('get-window-id', (e) => {
  e.returnValue = (e.sender as any).windowId;
});

ipcMain.handle(
  `web-contents-call`,
  async (e, { webContentsId, method, args = [] }) => {
    try {
      const wc = webContents.fromId(webContentsId);
      const result = (wc as any)[method](...args);

      if (result) {
        if (result instanceof Promise) {
          return await result;
        }

        return result;
      }
    } catch (e) {
      console.error(e);
    }
  },
);

// We need to prevent extension background pages from being garbage collected.
const backgroundPages: Electron.WebContents[] = [];

app.on('web-contents-created', (e, webContents) => {
  if (webContents.getType() === 'backgroundPage')
    backgroundPages.push(webContents);
});

const internalApiUrls = [
  'https://api.cohere.com',
  'https://openrouter.ai',
  'https://qdrant.socrathink.com'
];


ipcMain.handle('load-url', async (event, url: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    throw new Error('Unable to find the browser window');
  }

  try {
    // Create a new, temporary BrowserView to load the URL
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    win.setBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); // Hide the view

    // Load the URL in the temporary view
    await view.webContents.loadURL(url);

    // Get the page title
    const title = view.webContents.getTitle();

    // Get the full HTML content
    const html = await view.webContents.executeJavaScript(`
      document.documentElement.outerHTML
    `);

    // Parse the HTML to markdown
    const markdownContent = parseMarkdown(html);

    // Remove the temporary view
    win.removeBrowserView(view);

    return { title, content: markdownContent };
  } catch (error) {
    console.error('Error loading URL:', error);
    throw error;
  }
});


export function handleContextOmnidoraRequest(url: string, options?: RequestInit): Promise<Response> {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const pathName = decodeURIComponent(parsedUrl.pathname);
    const method = options?.method?.toUpperCase() || 'GET';

    const downloadsPath = app.getPath('downloads');

    const createResponse = (status: number, body: any = null, contentType: string = 'application/json') => {
      const content = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
      const buffer = Buffer.from(content);
      const headers = {
        'Content-Type': contentType,
        'Content-Length': buffer.length.toString()
      };

      const customResponse = new Response(method === 'HEAD' ? null : buffer, { status, headers });

      // Add arrayBuffer method to the response
      customResponse.arrayBuffer = async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

      return customResponse;
    };

    if (pathName === '/downloads') {
      fs.readdir(downloadsPath, (err, files) => {
        if (err) {
          resolve(createResponse(500, { error: `Error reading downloads folder: ${err.message}` }));
        } else {
          resolve(createResponse(200, files));
        }
      });
    } else if (pathName.startsWith('/downloads/')) {
      const parts = pathName.split('/').slice(2);
      const fileName = parts[0];
      const filePath = path.join(downloadsPath, fileName);

      fs.stat(filePath, (err, stats) => {
        if (err) {
          if (err.code === 'ENOENT') {
            resolve(createResponse(404, { error: 'File not found' }));
          } else {
            resolve(createResponse(500, { error: `Error reading file: ${err.message}` }));
          }
        } else {
          const baseContentType = lookup(filePath) || 'application/octet-stream';

          if (method === 'HEAD') {
            const headers = {
              'Content-Type': baseContentType,
              'Content-Length': stats.size.toString(),
              'Last-Modified': stats.mtime.toUTCString()
            };
            resolve(new Response(null, { status: 200, headers }));
          } else {
            fs.readFile(filePath, (err, data) => {
              if (err) {
                resolve(createResponse(500, { error: `Error reading file: ${err.message}` }));
              } else {
                if (parts.length > 1 && baseContentType === 'application/json') {
                  try {
                    let content = JSON.parse(data.toString());
                    for (let i = 1; i < parts.length; i++) {
                      content = content[parts[i]];
                    }
                    const contentType = typeof content === 'object' ? 'application/json' : 'text/plain';
                    resolve(createResponse(200, content, contentType));
                  } catch (error) {
                    resolve(createResponse(400, { error: 'Invalid JSON path' }));
                  }
                } else {
                  const customResponse = new Response(data, {
                    status: 200,
                    headers: {
                      'Content-Type': baseContentType,
                      'Content-Length': stats.size.toString(),
                      'Last-Modified': stats.mtime.toUTCString()
                    }
                  });

                  // Add arrayBuffer method to the response
                  customResponse.arrayBuffer = async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

                  resolve(customResponse);
                }
              }
            });
          }
        }
      });
    } else {
      resolve(createResponse(404, { error: 'Not found' }));
    }
  });
}
// Update the IPC handler
ipcMain.handle('context-socrathink-request', async (event, url) => {
  try {
    return await handleContextOmnidoraRequest(url);
  } catch (error) {
    console.error('Error handling context-socrathink-request:', error);
    throw error;
  }
});

import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// Listen for update events
autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...');
});

autoUpdater.on('update-available', (info) => {
  log.info('Update available.', info);
});

autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available.', info);
});

autoUpdater.on('error', (err) => {
  log.error('Error in auto-updater. ', err);
});

autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  log.info(log_message);
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded', info);
});

// Check for updates
app.on('ready', () => {
  autoUpdater.checkForUpdatesAndNotify();
});
