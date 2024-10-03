// src/main/services/queue-manager.ts

import { simpleFetch } from '~/utils/hybrid-fetch';
import { handleContextOmnidoraRequest } from '..';
import { sha256 } from 'hash-wasm';
import { CrawlStore } from '~/renderer/views/app/store/crawl-store';
import { getAuthInfo, SerializableAuthInfo } from './context';
import { Pool, ModuleThread } from 'threads';
import { extractQueryParams } from '~/utils/url';
import { parseMarkdown } from '~/utils/parse';
import { CrawlerWorker } from './worker';

export interface CrawledData {
    url: string;
    rawHtml: string;
    content: string;
    links: string[];
    completed: boolean;
    depth: number;
}

export class QueueManager {
    private urlQueue: { url: string; depth: number; timestamp: number }[] = [];
    private crawlCount: number = 0;
    private crawlStore: CrawlStore;
    private pool: Pool<CrawlerWorker>;
    private isProcessing: boolean = false;

    private readonly MAX_DEPTH = 3;
    private readonly MAX_CRAWLS: number = -1;

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
        this.pool = pool;
    }

    public async enqueue(url: string, depth: number = 1): Promise<void> {
        const urlObj = new URL(url);

        if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'socrathink:') {
            console.log(`Skipping ${url}: Only HTTPS and socrathink protocols are allowed`);
            return;
        }

        const { strippedUrl } = extractQueryParams(url);
        const urlHash = await this.hashString(strippedUrl);

        const existingEntry = await this.crawlStore.get(strippedUrl);
        if (existingEntry && existingEntry.ingested) {
            console.log(`Skipping ${url}: Already ingested`);
            return;
        }

        if (!this.urlQueue.some(item => item.url === url)) {
            this.urlQueue.push({ url, depth, timestamp: Date.now() });
            this.sortQueue();
            if (!this.isProcessing) {
                console.log('processing queue');
                await this.processQueue();
            }
        }
    }

    private sortQueue(): void {
        this.urlQueue.sort((a, b) => {
            if (a.depth !== b.depth) {
                return a.depth - b.depth; // Lower depth first
            }
            return b.timestamp - a.timestamp; // Newer timestamp first
        });
    }

    private async processQueue(): Promise<void> {
        console.log('processing queue');
        this.isProcessing = true;
        while (this.crawlCount < this.MAX_CRAWLS || this.MAX_CRAWLS === -1) {
            if (this.urlQueue.length === 0) {
                this.isProcessing = false;
                return;
            }
            console.log('processing queue', this.urlQueue.length);
            this.sortQueue()
            console.log('processing queue', this.urlQueue.length);
            const item = this.urlQueue.shift();
            if (item) {
                try {
                    const authInfo: SerializableAuthInfo = await getAuthInfo(item.url);
                    const result = await this.pool.queue(worker => worker.crawlUrl(authInfo, item.depth));
                    await this.handleCrawlResult(result);
                } catch (error) {
                    console.error(`Error processing URL: ${item.url}`, error);
                    this.handleFailedCrawl(item.url);
                }
                this.crawlCount++;
            }
        }
        this.isProcessing = false;
    }

    private async handleCrawlResult(result: CrawledData) {
        const { url, rawHtml, content, links, depth } = result;
        if (rawHtml && content) {
            const added = await this.crawlStore.add(url, rawHtml, content, depth);
        }
        if (depth < this.MAX_DEPTH) {
            for (const link of links) {
                await this.enqueue(link, depth + 1);
            }
        }
        console.log(`Processed URL: ${url}, extracted ${links.length} links, depth: ${depth}`);
    }

    private handleFailedCrawl(url: string): void {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;
        this.urlQueue = this.urlQueue.filter(item => new URL(item.url).hostname !== domain);
        this.urlQueue.push({ url, depth: this.MAX_DEPTH, timestamp: Date.now() });
        this.sortQueue();
    }

    private async hashString(str: string): Promise<string> {
        return await sha256(str);
    }

    public async addInitialUrl(url: string): Promise<void> {
        await this.enqueue(url, 0);
    }
}