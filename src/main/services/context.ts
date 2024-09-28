import { BrowserWindow, app, ipcMain } from 'electron';
import { session } from 'electron';
import { URL } from 'url';
import { getUserAgentForURL } from '../user-agent';
import { Application } from '../application';
import { hybridFetch } from '~/utils/hybrid-fetch';
import { CrawlStore, StoredCrawlData } from '~/renderer/views/app/store/crawl-store';
import { async } from 'rxjs';
import { NetworkStore, StoredNetworkData, ToolDocument } from '~/renderer/views/app/store/network-store';
import { run } from '~/utils/model';

export class ContextService {
    constructor() {
        this.setupIpcHandlers();
    }

    private setupIpcHandlers() {
        ipcMain.handle('transformers:run', async (event, text: string) => {
            return run(text);
        });
        ipcMain.handle('authed-fetch', async (event, url: string, options: AuthFetchOptions = {}) => {
            try {
                if (url && url.length > 0) {
                    const authInfo = await getAuthInfo(url, options);

                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('Request timed out')), 30000); // 30 seconds timeout
                    });

                    const fetchPromise = hybridFetch(authInfo.url, {
                        headers: {
                            ...options.headers,
                            ...authInfo.headers,
                        },
                    });

                    const responseData = await Promise.race([fetchPromise, timeoutPromise]);

                    return {
                        ok: true,
                        status: 200,
                        data: responseData["content"],
                    };
                } else {
                    return {
                        ok: false,
                        status: 400,
                        data: 'Invalid URL',
                    };
                }
            } catch (error) {
                console.error('Authed fetch error:', error);
                if (error.message === 'Request timed out') {
                    return {
                        ok: false,
                        status: 408,
                        data: 'Request timed out',
                    };
                }
                return {
                    ok: false,
                    status: 500,
                    data: 'Internal server error',
                };
            }
        });

        ipcMain.handle('fetch-context', async (event) => {
            try {
                const crawlStore = await CrawlStore.getInstance();
                const context = await this.fetchContext(crawlStore);
                return {
                    ok: true,
                    status: 200,
                    data: context,
                };
            } catch (error) {
                console.error('Fetch context error:', error);
                return {
                    ok: false,
                    status: 500,
                    data: 'Internal server error',
                };
            }
        });

        // New IPC handler for retrieving tools
        ipcMain.handle('get-tools', async (event) => {
            try {
                const networkStore = await NetworkStore.getInstance();
                const tools = await networkStore.getTools();
                return {
                    ok: true,
                    status: 200,
                    data: tools,
                };
            } catch (error) {
                console.error('Get tools error:', error);
                return {
                    ok: false,
                    status: 500,
                    data: 'Internal server error',
                };
            }
        });
    }

    private async fetchContext(crawlStore: CrawlStore): Promise<StoredCrawlData[]> {
        const allEntries = await crawlStore.getAll();
        console.log('allEntries', allEntries);

        // Filter and sort depth 0 entries by timestamp, most recent first
        const sortedDepth0Entries = allEntries
            .filter(entry => entry.depth === 0)
            .sort((a, b) => b.timestamp - a.timestamp);

        // Get the top 10 depth 0 entries
        const top10Depth0 = sortedDepth0Entries.slice(0, 10);

        // Filter and sort non-depth 0 entries by timestamp, most recent first
        const sortedNonDepth0Entries = allEntries
            .filter(entry => entry.depth !== 0)
            .sort((a, b) => b.timestamp - a.timestamp);

        // Get the top 10 non-depth 0 entries
        const top10NonDepth0 = sortedNonDepth0Entries.slice(0, 10);

        const sortedDepthNullEntries = allEntries
            .filter(entry => entry.depth === null)
            .sort((a, b) => b.timestamp - a.timestamp);

        // Combine the results
        const result = [...sortedDepthNullEntries, ...top10Depth0, ...top10NonDepth0];

        console.log(`Returning ${result.length} entries (${sortedDepthNullEntries.length} depth null, ${top10Depth0.length} depth 0, ${top10NonDepth0.length} non-depth 0)`);

        return result;
    }
}

export interface AuthFetchOptions extends Omit<Electron.ClientRequestConstructorOptions, 'url'> {
    headers?: Record<string, string>;
    timeout?: number;
}

export interface SerializableAuthInfo {
    headers: Record<string, string>;
    url: string;
}

export async function getAuthInfo(url: string, options: AuthFetchOptions = {}): Promise<SerializableAuthInfo> {
    const { headers: customHeaders } = options;

    // Parse the URL
    const parsedUrl = new URL(url);

    const cookies = await Application.instance.sessions.view.cookies.get({ url });
    const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');

    // Get the user agent
    const userAgent = getUserAgentForURL(session.defaultSession.getUserAgent(), url);

    // Prepare headers
    const headers: Record<string, string> = {
        'User-Agent': userAgent,
        'Cookie': cookieHeader,
        ...customHeaders,
    };

    return {
        headers,
        url: parsedUrl.toString(),
    };
}