import { hybridFetch, simpleFetch } from '~/utils/hybrid-fetch';
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
import { search, SafeSearchType } from 'duck-duck-scrape';
import { similarity } from '@nlpjs/similarity';

export interface CrawledData {
    url: string;
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
    similarityScore: number;
    metric: number;
    parentContent?: string;
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

    private readonly MAX_DEPTH = 3;
    private readonly MAX_CRAWLS: number = -1;
    private readonly MAX_QUEUE_SIZE = 1000;

    // Weights for the metric calculation
    private readonly WEIGHT_DEPTH = 1.0;
    private readonly WEIGHT_RECENCY = 1.0;
    private readonly WEIGHT_SIMILARITY = 1.0;

    constructor(crawlStore: CrawlStore, pool: Pool<CrawlerWorker>) {
        this.crawlStore = crawlStore;
        this.pool = Pool(() => spawn<CrawlerWorker>(new Worker(workerPath)), {
            size: 3,
            concurrency: 3,
            maxQueuedJobs: 30
        });
        this.queueStore = new Datastore<QueueItem>({
            filename: getPath('storage/q-mgr.db'),
            autoload: true,
        });

        this.purgeQueueStore();

        // this.queueStore.ensureIndex({ fieldName: 'url', unique: true });
        this.queueStore.ensureIndex({ fieldName: 'metric' });
        this.queueStore.ensureIndex({ fieldName: 'timestamp' });
        this.queueStore.ensureIndex({ fieldName: 'depth' });

        this.crawlStore.on('queryChanged', this.handleQueryChange.bind(this));
    }

    private async calculateSimilarityScore(text: string): Promise<number> {
        if (!this.crawlStore.currentActiveQuery) {
            return 0;
        }
        return similarity(this.crawlStore.currentActiveQuery, text);
    }

    private calculateMetric(item: QueueItem): number {
        // Calculate recency in milliseconds
        const now = Date.now();
        const recency = now - item.timestamp;

        // Normalize recency to a scale (e.g., more recent => higher score)
        const recencyScore = 1 / (1 + recency / (1000 * 60 * 10)); // 10 minutes decay

        // Composite metric: higher similarity and recency with lower depth are better
        return (this.WEIGHT_SIMILARITY * item.similarityScore) +
            (this.WEIGHT_RECENCY * recencyScore) -
            (this.WEIGHT_DEPTH * item.depth);
    }

    private purgeQueueStore(): void {
        this.queueStore.remove({}, { multi: true }, (err, numRemoved) => {
            if (err) {
                console.error('Error purging queue store:', err);
            } else {
                console.log(`Purged ${numRemoved} items from the queue store`);
            }
        });
    }

    private async insertQueueItem(item: QueueItem): Promise<void> {
        const queueSize = await this.getQueueSize();
        if (queueSize >= this.MAX_QUEUE_SIZE) {
            await this.removeLowestScoringItem();
        }

        // Calculate and set the metric
        item.metric = this.calculateMetric(item);

        return new Promise((resolve, reject) => {
            this.queueStore.insert(item, (err) => {
                if (err) {
                    // console.error('Error inserting queue item:', err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private async getQueueSize(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.queueStore.count({}, (err, count) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(count);
                }
            });
        });
    }

    private async removeLowestScoringItem(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.queueStore.find({})
                .sort({ metric: 1 }) // Lowest metric first
                .limit(1)
                .exec((err, docs) => {
                    if (err) {
                        reject(err);
                    } else if (docs.length > 0) {
                        this.queueStore.remove({ _id: docs[0]._id }, {}, (removeErr) => {
                            if (removeErr) {
                                reject(removeErr);
                            } else {
                                resolve();
                            }
                        });
                    } else {
                        resolve();
                    }
                });
        });
    }

    public async initiateActiveCrawl(query: string): Promise<void> {
        await this.crawlStore.initiateActiveCrawl(query);
    }

    public async addInitialUrl(url: string): Promise<void> {
        console.log('addInitialUrl', url);
        const similarityScore = await this.calculateSimilarityScore(url);
        await this.enqueue(url, 0, similarityScore);
    }

    private async enqueue(url: string, depth: number = 1, similarityScore?: number, parentContent?: string): Promise<void> {
        console.log('enqueue', url);

        // Check if the URL is already in the CrawlStore
        const existingEntry = await this.crawlStore.get(url);
        if (existingEntry) {
            console.log(`Skipping ${url}: Already in CrawlStore`);
            return;
        }

        const urlObj = new URL(url);
        if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:' && urlObj.protocol !== 'socrathink:') {
            console.log(`Skipping ${url}: Only HTTPS, HTTP, and socrathink protocols are allowed`);
            return;
        }

        similarityScore = similarityScore ?? await this.calculateSimilarityScore(url);
        const newItem: QueueItem = { url, depth, timestamp: Date.now(), similarityScore, metric: 0, parentContent };

        try {
            await this.insertQueueItem(newItem);
        } catch (error: any) {
            if (error.errorType === 'uniqueViolated') {
                console.log(`Skipping ${url}: Already in queue`);
                return;
            }
            throw error;
        }

        await this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            let nextItem = await this.getNextQueueItem();

            while (nextItem && (this.MAX_CRAWLS === -1 || this.crawlCount < this.MAX_CRAWLS)) {
                try {
                    console.log('nextItem', nextItem);
                    const authInfo: SerializableAuthInfo = await getAuthInfo(nextItem.url);
                    const result = await this.pool.queue(worker => worker.crawlUrl(authInfo, nextItem.depth));
                    await this.handleCrawlResult(result);
                    console.log('result', result);
                } catch (error) {
                    console.error(`Error processing URL: ${nextItem.url}`, error);
                    this.handleFailedCrawl(nextItem.url);
                }

                await this.removeQueueItem(nextItem.url);
                this.crawlCount++;

                nextItem = await this.getNextQueueItem();
            }
        } finally {
            this.isProcessing = false;
        }
    }

    private async getNextQueueItem(): Promise<QueueItem | null> {
        return new Promise((resolve, reject) => {
            this.queueStore.find({})
                .sort({ metric: -1 }) // Highest metric first
                .limit(1)
                .exec((err, docs) => {
                    if (err) {
                        console.error('Error fetching next queue item:', err);
                        reject(err);
                    } else {
                        resolve(docs[0] || null);
                    }
                });
        });
    }

    private async removeQueueItem(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.queueStore.remove({ url }, {}, (err) => {
                if (err) {
                    console.error('Error removing queue item:', err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    private async handleCrawlResult(result: CrawledData): Promise<void> {
        const { url, content, links, depth, lastModified } = result;
        if (content) {
            const similarityScore = await this.calculateSimilarityScore(content);
            const metric = this.calculateMetric({
                url,
                depth,
                timestamp: Date.now(),
                similarityScore,
                metric: 0
            });
            const crawlItem = {
                url,
                content,
                depth,
                lastModified,
                similarityScore,
                metric
            };
            await this.crawlStore.add(
                url,
                content,
                depth,
                lastModified,
                similarityScore,
                metric,
                (err) => {
                    if (err) {
                        console.error(`Error adding URL: ${url}`, err);
                    }
                }
            );
        }

        const contentLines = content.split('\n');
        const linkScores = await Promise.all(links.map(async (link) => {
            const linkIndex = contentLines.findIndex(line => line.includes(link));
            if (linkIndex === -1) {
                return { link, score: 0 };
            }
            const start = Math.max(0, linkIndex - 5);
            const end = Math.min(contentLines.length, linkIndex + 6);
            const surroundingContent = contentLines.slice(start, end).join('\n');
            const score = await this.calculateSimilarityScore(surroundingContent);
            return { link, score, surroundingContent };
        }));

        await Promise.all(linkScores.map(({ link, score, surroundingContent }) =>
            this.enqueue(link, depth + 1, score, surroundingContent)
        ));

        console.log(`Processed URL: ${url}, extracted ${links.length} links, depth: ${depth}`);
    }

    private handleFailedCrawl(url: string): void {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;

        this.queueStore.remove({ url: new RegExp(`^https?://${domain}`) }, { multi: true }, (err, numRemoved) => {
            if (err) {
                console.error('Error removing failed crawl items:', err);
            } else {
                console.log(`Removed ${numRemoved} items from domain ${domain}`);
            }
        });

        const failedItem: QueueItem = {
            url,
            depth: this.MAX_DEPTH,
            timestamp: Date.now(),
            similarityScore: 0,
            metric: this.calculateMetric({
                url,
                depth: this.MAX_DEPTH,
                timestamp: Date.now(),
                similarityScore: 0,
                metric: 0
            })
        };
        this.enqueue(failedItem.url, failedItem.depth, failedItem.similarityScore);
    }

    private async handleQueryChange(newQuery: string): Promise<void> {
        console.log('Updating similarity scores due to query change.');

        // Add relevant initial URLs
        const relevantUrls = await this.fetchRelevantInitialUrls(newQuery, 20);
        for (const url of relevantUrls) {
            await this.enqueue(url, 0, 100000);
        }
        console.log('relevantUrls', relevantUrls);

        // Restart queue processing
        await this.processQueue();
    }
    private async fetchRelevantInitialUrls(query: string, size: number): Promise<string[]> {
        try {
            const { links } = await hybridFetch(`https://duckduckgo.com/html/?q=${query}`);
            const extractedLinks = links.map(link => {
                const match = link.match(/uddg=([^&]+)/);
                if (match && match[1]) {
                    return decodeURIComponent(match[1]);
                }
                return link;
            });
            console.log('links', extractedLinks);

            return extractedLinks.slice(1, size);
        } catch (error) {
            console.error('Error fetching initial URLs from DuckDuckGo:', error);
            return [];
        }
    }
}
