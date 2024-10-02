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

export class ContextService {
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
    }

    private async fetchContext(crawlStore: CrawlStore): Promise<StoredCrawlData[]> {
        const unIngestedEntries = await crawlStore.getUnIngested();
        console.log('Uningested entries:', unIngestedEntries.length);

        const MAX_ITEMS_TO_INGEST = 100;

        // Filter out entries with null content
        const validEntries = unIngestedEntries.filter(item => item.content !== null);

        // Sort entries
        const sortedEntries = validEntries.sort((a, b) => {
            if (a.depth === null && b.depth === null) return 0;
            if (a.depth === null) return -1;
            if (b.depth === null) return 1;
            if (a.depth !== b.depth) {
                return a.depth - b.depth; // Sort by depth (lowest first)
            }

            const isPdfA = a.url.includes('/pdf') || a.url.includes('.pdf');
            const isPdfB = b.url.includes('/pdf') || b.url.includes('.pdf');

            if (isPdfA && !isPdfB) return -1;
            if (!isPdfA && isPdfB) return 1;

            return 0;
        });

        // Density-based clustering for sessions
        const EPSILON = 5 * 60 * 1000; // 5 minutes in milliseconds
        const MIN_POINTS = 2; // Minimum number of points to form a cluster

        function dbscan(items: StoredCrawlData[]): Array<StoredCrawlData[]> {
            const clusters: Array<StoredCrawlData[]> = [];
            const visited = new Set<number>();

            function expandCluster(point: StoredCrawlData, neighbors: StoredCrawlData[], cluster: StoredCrawlData[]) {
                cluster.push(point);

                for (let i = 0; i < neighbors.length; i++) {
                    const neighborIndex = items.indexOf(neighbors[i]);
                    if (!visited.has(neighborIndex)) {
                        visited.add(neighborIndex);
                        const newNeighbors = getNeighbors(neighbors[i]);
                        if (newNeighbors.length >= MIN_POINTS) {
                            neighbors.push(...newNeighbors);
                        }
                    }

                    if (!cluster.includes(neighbors[i])) {
                        cluster.push(neighbors[i]);
                    }
                }
            }

            function getNeighbors(point: StoredCrawlData): StoredCrawlData[] {
                return items.filter(p => Math.abs(p.timestamp - point.timestamp) <= EPSILON);
            }

            for (let i = 0; i < items.length; i++) {
                if (visited.has(i)) continue;

                visited.add(i);
                const neighbors = getNeighbors(items[i]);

                if (neighbors.length < MIN_POINTS) {
                    clusters.push([items[i]]); // Noise points form their own clusters
                } else {
                    const cluster: StoredCrawlData[] = [];
                    expandCluster(items[i], neighbors, cluster);
                    clusters.push(cluster);
                }
            }

            return clusters;
        }

        const sessions = dbscan(sortedEntries);

        // Sort sessions by most recent first, then sort items within each session by oldest first
        sessions.sort((a, b) => Math.max(...b.map(item => item.timestamp)) - Math.max(...a.map(item => item.timestamp)));
        sessions.forEach(session => session.sort((a, b) => a.timestamp - b.timestamp));

        // Flatten the sorted sessions back into a single array
        const result = sessions.flat().slice(0, MAX_ITEMS_TO_INGEST);

        console.log(`Returning ${result.length} entries`);

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