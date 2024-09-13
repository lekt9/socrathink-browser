import { WebContents } from 'electron';
import { CrawlStore } from '~/renderer/views/app/store/crawl-store';
import { QueueManager } from './queue-manager';
import electronDebug from 'electron-debug';
import { parseMarkdown } from '~/utils/parse';
import { extractLinks } from '~/utils/hybrid-fetch';

export class DevToolsCrawler {
    private webContents: WebContents;
    private crawlStore: CrawlStore;
    private queueManager: QueueManager;
    private isDebuggerAttached: boolean = false;

    constructor(webContents: WebContents, queueManager: QueueManager, crawlStore: CrawlStore) {
        this.webContents = webContents;
        this.queueManager = queueManager;
        this.crawlStore = crawlStore;
        this.attachDebugger();
        electronDebug({ showDevTools: false, devToolsMode: 'right' });
        this.webContents.on('did-navigate', this.handleDidNavigate);
    }

    private attachDebugger() {
        if (this.isDebuggerAttached) return;

        try {
            this.webContents.debugger.attach('1.3');
            console.log('Debugger attached successfully');
            this.webContents.debugger.on('message', this.handleDebuggerMessage);
            this.webContents.debugger.sendCommand('Network.enable');
            this.isDebuggerAttached = true;
        } catch (err) {
            console.error('Failed to attach debugger:', err);
        }
    }

    private handleDidNavigate = () => {
        this.detachDebugger();
    }

    private detachDebugger() {
        if (!this.isDebuggerAttached) return;

        try {
            this.webContents.debugger.detach();
            console.log('Debugger detached successfully');
            this.isDebuggerAttached = false;
        } catch (err) {
            console.error('Failed to detach debugger:', err);
        }
    }

    private handleDebuggerMessage = (event: Electron.Event, method: string, params: any) => {
        if (method === 'Network.responseReceived') {
            this.handleResponse(params.response, params.type, params.requestId);
        }
    }

    private async handleResponse(response: any, resourceType: string, requestId: string) {
        try {
            const { url, mimeType, status } = response;

            // Skip non-HTML and non-JSON responses
            if (!mimeType || (!mimeType.includes('text/html') && !mimeType.includes('application/json'))) {
                return;
            }

            // Skip non-document resources (like images, stylesheets, etc.)
            if (resourceType !== 'Document' && resourceType !== 'XHR') {
                return;
            }

            // Get the response body using the requestId
            const { body, base64Encoded } = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: requestId });
            // Decode the body if it's base64 encoded
            const rawHtml = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;

            let processedContent;
            try {
                JSON.parse(rawHtml);
                processedContent = JSON.stringify(rawHtml);
                const links = extractLinks(processedContent, url);
                for (const link of links) {
                    this.queueManager.enqueue(link, 1);
                }
            } catch {
                const links = extractLinks(rawHtml, url);
                processedContent = parseMarkdown(rawHtml);
                for (const link of links) {
                    this.queueManager.enqueue(link, 1);
                }
            }

            if (status >= 200 && status < 300 && processedContent.length > 100) {
                // Add the content to the crawl store
                if (await this.crawlStore.add(url, rawHtml, processedContent, 0)) {
                    console.log("Successfully added to CrawlStore");
                }
            }
        } catch (error) {
            console.error('Error handling response:', error);
        }
    }
}