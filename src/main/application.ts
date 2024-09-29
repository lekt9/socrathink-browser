import fuzzysort from 'fuzzysort';
import { app, ipcMain, Menu } from 'electron';
import { isAbsolute, extname } from 'path';
import { existsSync } from 'fs';
import { SessionsService } from './sessions-service';
import { checkFiles } from '~/utils/files';
import { Settings } from './models/settings';
import { isURL, prefixHttp } from '~/utils';
import { WindowsService } from './windows-service';
import { StorageService } from './services/storage';
import { getMainMenu } from './menus/main';
import { runAutoUpdaterService } from './services';
import { DialogsService } from './services/dialogs-service';
import { requestAuth } from './dialogs/auth';
import { NetworkServiceHandler } from './network/network-service-handler';
import { ExtensionServiceHandler } from './extension-service-handler';
import { handleContextOmnidoraRequest } from '.';
import { parsePdf } from '~/utils/hybrid-fetch';

export class Application {
  public static instance = new Application();

  public sessions: SessionsService;

  public settings: Settings;

  public storage: StorageService;

  public windows: WindowsService;

  public dialogs = new DialogsService();
  private splitIntoChunks(text: string, maxChunkSize: number = 8000, totalSize: number): { text: string, estimatedPage: number }[] {
    const chunks: { text: string, estimatedPage: number }[] = [];
    let currentChunk = '';
    let currentPosition = 0;

    const paragraphs = text.split(/\n\s*\n/);

    for (const paragraph of paragraphs) {
      const sentences = paragraph.split(/(?<=[.!?])\s+/);

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length + 1 <= maxChunkSize) {
          currentChunk += (currentChunk ? ' ' : '') + sentence;
        } else {
          if (currentChunk) {
            const estimatedPage = Math.ceil((currentPosition / totalSize) * 100); // Assuming 100 pages total
            chunks.push({ text: currentChunk.trim(), estimatedPage });
            currentPosition += currentChunk.length;
          }
          currentChunk = sentence;
        }
      }

      if (currentChunk) {
        currentChunk += '\n\n';
      }
    }

    if (currentChunk) {
      const estimatedPage = Math.ceil((currentPosition / totalSize) * 100); // Assuming 100 pages total
      chunks.push({ text: currentChunk.trim(), estimatedPage });
    }

    return chunks;
  }

  private async findMostSimilarPage(pdfContent: string, searchText: string): Promise<number> {
    const pages = pdfContent.split(/\f/); // Split PDF content into pages
    const fuzzyResults = pages.map((page, index) => ({
      index: index + 1,
      score: fuzzysort.single(searchText, page)?.score ?? Number.NEGATIVE_INFINITY
    }));

    fuzzyResults.sort((a, b) => b.score - a.score);
    return fuzzyResults[0].index;
  }
  public async start() {
    const gotTheLock = app.requestSingleInstanceLock();

    if (!gotTheLock) {
      app.quit();
      return;
    } else {
      app.on('open-url', async (_, url) => {
        if (!this.windows.current) {
          this.windows.current = this.windows.open();
        }
        this.windows.current.win.focus();
        await this.windows.current.viewManager.create({
          url: url,
          active: true,
        });
        this.windows.current.win.webContents.once('dom-ready', async () => {
          await this.windows.current.viewManager.create({
            url: url,
            active: true,
          });
        });
      });

      app.on('second-instance', async (e, argv) => {
        const path = argv[argv.length - 1];

        if (isAbsolute(path) && existsSync(path)) {
          if (process.env.NODE_ENV !== 'development') {
            const path = argv[argv.length - 1];
            const ext = extname(path);

            if (ext === '.html') {
              if (!this.windows.current) {
                this.windows.current = this.windows.open();
              }

              this.windows.current.win.focus();
              this.windows.current.viewManager.create({
                url: `file:///${path}`,
                active: true,
              });
              this.windows.current.win.webContents.once('dom-ready', () => {
                this.windows.current.viewManager.create({
                  url: `file:///${path}`,
                  active: true,
                });
              });
            }
          }
          return;
        } else if (isURL(path)) {
          if (!this.windows.current) {
            this.windows.current = this.windows.open();
          }

          this.windows.current.win.focus();
          this.windows.current.viewManager.create({
            url: prefixHttp(path),
            active: true,
          });
          this.windows.current.win.webContents.once('dom-ready', () => {
            this.windows.current.viewManager.create({
              url: prefixHttp(path),
              active: true,
            });
          });

          return;
        }

        this.windows.open();
      });
    }

    app.on('login', async (e, webContents, request, authInfo, callback) => {
      e.preventDefault();

      const window = this.windows.findByBrowserView(webContents.id);
      const credentials = await requestAuth(
        window.win,
        request.url,
        webContents.id,
      );

      if (credentials) {
        callback(credentials.username, credentials.password);
      }
    });

    ipcMain.on('create-window', (e, incognito = false) => {
      this.windows.open(incognito);
    });

    ipcMain.handle('open-url', async (e, url, scrollToText?: string) => {
      // console.log({ url, scrollToText });

      if (!this.windows.current) {
        this.windows.current = this.windows.open();
      }
      this.windows.current.win.focus();

      this.windows.current.viewManager.create({
        url: url,
        active: true,
      }, false, true, false, scrollToText);

    });
    await this.onReady();
  }

  private async onReady() {
    await app.whenReady();

    new ExtensionServiceHandler();

    NetworkServiceHandler.get();

    checkFiles();

    this.sessions = new SessionsService();
    this.windows = new WindowsService(this.sessions);
    this.settings = new Settings();
    this.storage = new StorageService(this.settings);

    await this.storage.run();
    await this.dialogs.run();

    this.windows.open();

    Menu.setApplicationMenu(getMainMenu());
    runAutoUpdaterService();

    app.on('activate', () => {
      if (this.windows.list.filter((x) => x !== null).length === 0) {
        this.windows.open();
      }
    });
  }
}
