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
    private depth0UrlsToCrawl: string[] = [];
    private otherUrlsToCrawl: string[] = [];
    private crawledHashes: Set<string> = new Set();
    private requestCount: number = 0;
    private urlDepthMap: Map<string, number> = new Map();
    private readonly MAX_DEPTH = 2;
    private readonly MAX_CRAWLS: number = -1;
    private crawlCount: number = 0;
    private crawlStore: CrawlStore;
    private pool: Pool<CrawlerWorker>;
    private isProcessing: boolean = false;

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

        const urlHash = await this.hashString(url);

        if (!this.crawledHashes.has(urlHash) &&
            !this.depth0UrlsToCrawl.includes(url) &&
            !this.otherUrlsToCrawl.includes(url)) {
            if (depth === 0) {
                this.depth0UrlsToCrawl.push(url);
            } else {
                this.otherUrlsToCrawl.push(url);
            }
            this.urlDepthMap.set(url, depth);

            if (!this.isProcessing) {
                this.processQueue();
            }
        }
    }

    private async processQueue(): Promise<void> {
        this.isProcessing = true;
        while (this.crawlCount < this.MAX_CRAWLS || this.MAX_CRAWLS === -1) {
            if (this.isEmpty()) {
                this.isProcessing = false;
                return;
            }
            const url = this.dequeue();
            if (url) {
                try {
                    const depth = this.urlDepthMap.get(url) || 0;
                    const authInfo: SerializableAuthInfo = await getAuthInfo(url);
                    console.log({ pool: this.pool });
                    const result = await this.pool.queue(worker => worker.crawlUrl(authInfo, depth));
                    await this.handleCrawlResult(result);
                } catch (error) {
                    console.error(`Error processing URL: ${url}`, error);
                    this.handleFailedCrawl(url);
                }
                this.crawlCount++;
            }
        }
        this.isProcessing = false;
    }

    private async handleCrawlResult(result: CrawledData) {
        const { url, rawHtml, content, links, depth } = result;
        console.log({ rawHtml, content })
        if (rawHtml && content) {
            await this.crawlStore.add(url, rawHtml, content, depth);
        }
        if (depth < this.MAX_DEPTH) {
            for (const link of links) {
                await this.enqueue(link, depth + 1);
            }
        }
        console.log(`Processed URL: ${url}, extracted ${links.length} links, depth: ${depth}`);
    }

    private isAllowedContentType(contentType: string): boolean {
        return Array.from(this.allowedContentTypes).some(allowed => contentType.startsWith(allowed));
    }

    public dequeue(): string | undefined {
        this.requestCount++;
        if (this.requestCount % 10 === 0) {
            this.sortQueue();
        }

        if (this.depth0UrlsToCrawl.length > 0) {
            return this.depth0UrlsToCrawl.shift();
        } else {
            return this.otherUrlsToCrawl.shift();
        }
    }

    public isEmpty(): boolean {
        return this.depth0UrlsToCrawl.length === 0 && this.otherUrlsToCrawl.length === 0;
    }

    public async markAsCrawled(url: string): Promise<void> {
        const urlHash = await this.hashString(url);
        this.crawledHashes.add(urlHash);
    }

    public handleFailedCrawl(url: string): void {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;

        this.depth0UrlsToCrawl = this.moveFailedDomainToEnd(this.depth0UrlsToCrawl, domain);
        this.otherUrlsToCrawl = this.moveFailedDomainToEnd(this.otherUrlsToCrawl, domain);
    }

    private moveFailedDomainToEnd(queue: string[], domain: string): string[] {
        return queue.filter(u => {
            if (new URL(u).hostname === domain) {
                queue.push(u);
                return false;
            }
            return true;
        });
    }

    private sortQueue(): void {
        this.depth0UrlsToCrawl = this.sortQueueByDomain(this.depth0UrlsToCrawl);
        this.otherUrlsToCrawl = this.sortQueueByDomain(this.otherUrlsToCrawl);
    }

    private sortQueueByDomain(queue: string[]): string[] {
        const domainMap: Map<string, string[]> = new Map();

        for (const url of queue) {
            const domain = new URL(url).hostname;
            if (!domainMap.has(domain)) {
                domainMap.set(domain, []);
            }
            domainMap.get(domain)!.push(url);
        }

        const sortedQueue: string[] = [];
        const domains = Array.from(domainMap.keys());

        while (domains.length > 0) {
            for (let i = 0; i < domains.length; i++) {
                const domain = domains[i];
                const urls = domainMap.get(domain)!;
                if (urls.length > 0) {
                    sortedQueue.push(urls.shift()!);
                } else {
                    domains.splice(i, 1);
                    i--;
                }
            }
        }

        return sortedQueue;
    }

    private async hashString(str: string): Promise<string> {
        return await sha256(str);
    }

    public async addInitialUrl(url: string): Promise<void> {
        await this.enqueue(url, 0);
    }
}