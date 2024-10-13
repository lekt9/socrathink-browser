import { simpleFetch } from '~/utils/hybrid-fetch';
import { handleContextOmnidoraRequest } from '..';
import { sha256 } from 'hash-wasm';
import { CrawlStore } from '~/renderer/views/app/store/crawl-store';
import { getAuthInfo, SerializableAuthInfo } from './context';
import { extractQueryParams } from '~/utils/url';
import { parseMarkdown } from '~/utils/parse';
import { CrawlerWorker } from './worker';
import { ModuleThread, Pool, spawn, Worker } from 'threads';
import { app } from 'electron';
import * as Datastore from '@seald-io/nedb';
import { getPath } from '~/utils';

export interface CrawledData {
    url: string;
    rawHtml: string;
    content: string;
    links: string[];
    completed: boolean;
    depth: number;
    lastModified: string | null;
}

export interface QueueItem {
    url: string;
    depth: number;
    timestamp: number;
}

const workerPath = app.isPackaged
    ? `${process.resourcesPath}/worker.bundle.js`
    : `${app.getAppPath()}/build/worker.bundle.js`;

export class QueueManager {
    private crawlCount: number = 0;
    private crawlStore: CrawlStore;
    private pool: Pool<CrawlerWorker>;
    private isProcessing: boolean = false;
    private lastCrawlTime: number = 0;
    private queueStore: Datastore<QueueItem>;
    private memoryQueue: QueueItem[] = [];
    private lastProcessedDomain: string | null = null;

    private readonly MAX_DEPTH = 3;
    private readonly MAX_CRAWLS: number = -1;
    private readonly MEMORY_QUEUE_SIZE = 300;

    private allowedContentTypes: Set<string> = new Set([
        'text/html',
        'text/plain',
        'text/xml',
        'application/xml',
        'application/xhtml+xml',
        'application/html',
        'application/xhtml',
        'text/html-sandboxed',
        'application/json',
        'application/ld+json',
        'application/pdf'
    ]);

    constructor(crawlStore: CrawlStore, pool: Pool<CrawlerWorker>) {
        this.crawlStore = crawlStore;
        this.pool = Pool(() => spawn<CrawlerWorker>(new Worker(workerPath)), {
            size: 1,
            concurrency: 1
        });
        this.queueStore = new Datastore<QueueItem>({
            filename: getPath('storage/q.db'),
            autoload: true,
        });

        // Ensure indexes for efficient sorting
        this.queueStore.ensureIndex({ fieldName: 'depth' }, (err) => {
            if (err) {
                console.error('Error creating index on depth:', err);
            }
        });
        this.queueStore.ensureIndex({ fieldName: 'timestamp' }, (err) => {
            if (err) {
                console.error('Error creating index on timestamp:', err);
            }
        });
    }

    public async enqueue(url: string, depth: number = 1): Promise<void> {
        console.log('enqueue', url);
        const existingEntry = await this.crawlStore.get(url);
        console.log('existingEntry', existingEntry);
        if (existingEntry && existingEntry.content) {
            console.log(`Skipping ${url}: Already crawled`);
            return;
        }
        const urlObj = new URL(url);
        if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:' && urlObj.protocol !== 'socrathink:') {
            console.log(`Skipping ${url}: Only HTTPS, HTTP, and socrathink protocols are allowed`);
            return;
        }

        const newItem: QueueItem = { url, depth, timestamp: Date.now() };

        if (this.memoryQueue.length < this.MEMORY_QUEUE_SIZE) {
            this.memoryQueue.push(newItem);
            this.sortMemoryQueue();
        } else {
            await this.insertQueueItem(newItem);
        }

        await this.processQueue();
    }

    private sortMemoryQueue(): void {
        this.memoryQueue.sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth;
            }
            return b.timestamp - a.timestamp;
        });
    }

    private async insertQueueItem(item: QueueItem): Promise<void> {
        return new Promise((resolve, reject) => {
            this.queueStore.insert(item, (err) => {
                if (err) {
                    console.error('Error inserting queue item:', err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.crawlCount < this.MAX_CRAWLS || this.MAX_CRAWLS === -1) {
            const nextItem = await this.getNextQueueItem();
            if (!nextItem) {
                this.isProcessing = false;
                return;
            }

            try {
                const authInfo: SerializableAuthInfo = await getAuthInfo(nextItem.url);
                const result = await this.pool.queue(worker => worker.crawlUrl(authInfo, nextItem.depth));
                await this.handleCrawlResult(result);
                this.lastProcessedDomain = new URL(nextItem.url).hostname;
            } catch (error) {
                console.error(`Error processing URL: ${nextItem.url}`, error);
                this.handleFailedCrawl(nextItem.url);
            }

            await this.removeQueueItem(nextItem.url);
            this.crawlCount++;
        }

        this.isProcessing = false;
    }

    private async getNextQueueItem(): Promise<QueueItem | null> {
        let nextItem: QueueItem | null = null;

        if (this.memoryQueue.length > 0) {
            nextItem = this.getNextMemoryQueueItem();
        }

        if (!nextItem) {
            nextItem = await this.getNextStoredQueueItem();
            if (nextItem) {
                await this.repopulateMemoryQueue();
            }
        }

        return nextItem;
    }

    private getNextMemoryQueueItem(): QueueItem | null {
        const index = this.memoryQueue.findIndex(item => {
            const domain = new URL(item.url).hostname;
            return domain !== this.lastProcessedDomain;
        });

        if (index !== -1) {
            return this.memoryQueue.splice(index, 1)[0];
        }

        // If all items are from the same domain, return the first item
        return this.memoryQueue.shift() || null;
    }

    private async getNextStoredQueueItem(): Promise<QueueItem | null> {
        return new Promise((resolve, reject) => {
            this.queueStore.find({})
                .sort({ depth: 1, timestamp: -1 })
                .exec((err, docs) => {
                    if (err) {
                        console.error('Error fetching next queue item:', err);
                        reject(err);
                    } else {
                        const nextItem = docs.find(item => {
                            const domain = new URL(item.url).hostname;
                            return domain !== this.lastProcessedDomain;
                        });
                        resolve(nextItem || docs[0] || null);
                    }
                });
        });
    }

    private async repopulateMemoryQueue(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.queueStore.find({})
                .sort({ depth: 1, timestamp: -1 })
                .limit(this.MEMORY_QUEUE_SIZE)
                .exec((err, docs) => {
                    if (err) {
                        console.error('Error repopulating memory queue:', err);
                        reject(err);
                    } else {
                        this.memoryQueue = docs;
                        resolve();
                    }
                });
        });
    }

    private async removeQueueItem(url: string): Promise<void> {
        const memoryIndex = this.memoryQueue.findIndex(item => item.url === url);
        if (memoryIndex !== -1) {
            this.memoryQueue.splice(memoryIndex, 1);
            return;
        }

        return new Promise((resolve, reject) => {
            this.queueStore.remove({ url }, {}, (err, numRemoved) => {
                if (err) {
                    console.error('Error removing queue item:', err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private async handleCrawlResult(result: CrawledData) {
        const { url, rawHtml, content, links, depth, lastModified } = result;
        if (rawHtml && content) {
            const added = await this.crawlStore.add(url, rawHtml, content, depth, lastModified, (err) => {
                if (err) {
                    console.error(`Error adding URL: ${url}`, err);
                }
            });
        }
        if (depth < this.MAX_DEPTH) {
            if (depth > 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            for (const link of links) {
                await this.enqueue(link, depth + 1);
            }
        }
        console.log(`Processed URL: ${url}, extracted ${links.length} links, depth: ${depth}`);
    }

    private handleFailedCrawl(url: string): void {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;

        // Remove all items with the same domain from memory queue
        this.memoryQueue = this.memoryQueue.filter(item => !item.url.includes(domain));

        // Remove all items with the same domain from storage
        this.queueStore.remove({ url: new RegExp(`^https?://${domain}`) }, { multi: true }, (err, numRemoved) => {
            if (err) {
                console.error('Error removing failed crawl items:', err);
            } else {
                console.log(`Removed ${numRemoved} items from domain ${domain}`);
            }
        });

        // Re-enqueue the failed URL with MAX_DEPTH
        const failedItem: QueueItem = { url, depth: this.MAX_DEPTH, timestamp: Date.now() };
        this.enqueue(failedItem.url, failedItem.depth);
    }

    private async hashString(str: string): Promise<string> {
        return await sha256(str);
    }

    public async addInitialUrl(url: string): Promise<void> {
        console.log('addInitialUrl', url);
        await this.enqueue(url, 0);
    }
}