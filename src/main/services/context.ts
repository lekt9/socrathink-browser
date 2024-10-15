import { BrowserWindow, app, ipcMain } from 'electron';
import { session } from 'electron';
import { URL } from 'url';
import { getUserAgentForURL } from '../user-agent';
import { Application } from '../application';
import { hybridFetch } from '~/utils/hybrid-fetch';
import { CrawlStore, StoredCrawlData } from '~/renderer/views/app/store/crawl-store';
import { async } from 'rxjs';
import { NetworkStore, StoredNetworkData } from '~/renderer/views/app/store/network-store';
import { run } from '~/utils/model';
import { QueueManager } from './queue-manager';

export class ContextService {
    private queueManager: QueueManager;

    constructor() {
        this.setupIpcHandlers();
    }

    private setupIpcHandlers() {

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
                        title: responseData["title"],
                        lastModified: responseData["lastModified"],
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
                console.log('Getting tools');
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

        // New IPC handler for marking a URL as ingested
        ipcMain.handle('mark-as-ingested', async (event, url: string) => {
            try {
                const crawlStore = await CrawlStore.getInstance();
                const result = await crawlStore.markAsIngested(url);
                return {
                    ok: true,
                    status: 200,
                    data: result,
                };
            } catch (error) {
                console.error('Mark as ingested error:', error);
                return {
                    ok: false,
                    status: 500,
                    data: 'Internal server error',
                };
            }
        });

        ipcMain.handle('initiate-active-crawl', async (event, query: string) => {
            try {
                const crawlStore = await CrawlStore.getInstance();
                const results = await crawlStore.initiateActiveCrawl(query);
                return {
                    ok: true,
                    status: 200,
                    data: results,
                };
            } catch (error) {
                console.error('Initiate active crawl error:', error);
                return {
                    ok: false,
                    status: 500,
                    data: 'Internal server error',
                };
            }
        });
    }

    private async fetchContext(crawlStore: CrawlStore): Promise<StoredCrawlData[]> {
        const unIngestedEntries = await crawlStore.getUnIngested(100);

        // // Sort all entries by metric, descending
        // const sortedEntries = unIngestedEntries.sort((a, b) => b.metric - a.metric);

        // // Take the top 20 entries
        // const topEntries = sortedEntries.slice(0, 50);

        // console.log(`Returning ${topEntries.length} entries sorted by metric`);

        return unIngestedEntries;
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
    const cookies = await Application.instance.sessions.view.cookies.get({ domain: parsedUrl.hostname });

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
