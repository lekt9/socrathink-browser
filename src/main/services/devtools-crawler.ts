import { WebContents } from 'electron';
import { NetworkStore, StoredNetworkData } from '~/renderer/views/app/store/network-store';
import { QueueManager } from './queue-manager';
import electronDebug from 'electron-debug';
import { parseMarkdown } from '~/utils/parse';
import { extractLinks } from '~/utils/hybrid-fetch';
import { URL } from 'url';

export class DevToolsCrawler {
    private webContents: WebContents;
    private networkStore: NetworkStore;
    private queueManager: QueueManager;
    private isDebuggerAttached: boolean = false;
    private requestMap: Map<string, StoredNetworkData> = new Map();

    constructor(networkStore: NetworkStore, webContents: WebContents, queueManager: QueueManager) {
        this.webContents = webContents;
        this.queueManager = queueManager;
        this.networkStore = networkStore;
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
        this.attachDebugger();
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

    private handleDebuggerMessage = async (event: Electron.Event, method: string, params: any) => {
        switch (method) {
            case 'Network.requestWillBeSent':
                await this.handleRequest(params);
                break;
            case 'Network.responseReceived':
                await this.handleResponse(params);
                break;
            case 'Network.loadingFinished':
                await this.handleLoadingFinished(params);
                break;
        }
    }

    private async handleRequest(params: any) {
        // console.log('Handling request', params);
        const { requestId, request, initiator, type } = params;
        const { url, method, headers, postData } = request;

        // Add request to NetworkStore and retrieve the stored entry
        const storedEntry = await this.networkStore.addRequestToLog({
            requestId,
            url,
            method,
            headers,
            body: postData,
            initiator,
            type
        });

        if (storedEntry) {
            // Map the requestId to the stored entry
            this.requestMap.set(requestId, storedEntry);
        } else {
            // console.warn(`Failed to store request with ID: ${requestId}`);
        }
    }

    private async handleResponse(params: any) {
        const { requestId, response } = params;
        const request = this.requestMap.get(requestId);

        if (request) {
            const { status, headers } = response;
            request.responseStatus = status;
            request.responseHeaders = headers;
            // Update the entry in the database
            await this.networkStore.updateLogWithResponse({
                requestId: request.requestId,
                status,
                headers,
                body: undefined // Body will be updated in loadingFinished
            });
        } else {
            // console.warn(`No matching request found for response with ID: ${requestId}`);
        }
    }

    private async handleLoadingFinished(params: any) {
        const { requestId } = params;
        const request = this.requestMap.get(requestId);

        if (request && request.responseStatus !== 0) {
            try {
                const { body, base64Encoded } = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId });
                const rawBody = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;

                request.responseBody = rawBody;
                request.contentHash = await this.networkStore.hashString(rawBody);
                // Update the entry in the database with the response body
                await this.networkStore.updateLogWithResponse({
                    requestId: request.requestId,
                    status: request.responseStatus,
                    headers: request.responseHeaders,
                    body: rawBody
                });

                this.processResponseContent(request.baseUrl + request.path, rawBody, request.responseHeaders['content-type']);
            } catch (error) {
                console.error('Error handling loading finished:', error);
            } finally {
                // Remove the request from the map as it's fully processed
                this.requestMap.delete(requestId);
            }
        } else {
            // console.warn(`No valid request found for loading finished with ID: ${requestId}`);
        }
    }

    private async processResponseContent(url: string, rawBody: string, mimeType: string) {
        if (!mimeType || (!mimeType.includes('text/html') && !mimeType.includes('application/json'))) {
            return;
        }

        let processedContent = rawBody;
        try {
            if (mimeType.includes('application/json')) {
                JSON.parse(rawBody);
                processedContent = rawBody; // Corrected: stringified JSON should already be a string
            } else {
                processedContent = parseMarkdown(rawBody);
            }

            const links = extractLinks(processedContent, url);
            for (const link of links) {
                this.queueManager.enqueue(link, 1);
            }
        } catch (error) {
            console.error('Error processing response content:', error);
        }
    }
}