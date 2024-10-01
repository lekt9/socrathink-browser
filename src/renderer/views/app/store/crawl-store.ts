import * as Datastore from '@seald-io/nedb';
import { getPath } from '~/utils';
import { isContentUseful } from '~/utils/parse';
import { extractQueryParams } from '~/utils/url';
import { sha256 } from 'hash-wasm';

export interface StoredCrawlData {
    urlHash: string;
    url: string;
    contentHash: string;
    timestamp: number;
    content?: string;
    depth: number;
    ingested: boolean; // New field
}

export class CrawlStore {
    private static instance: CrawlStore;
    private db: Datastore;
    private readonly MAX_ITEMS = 2000;

    private constructor() {
        this.db = new Datastore({
            filename: getPath('storage/crawls.db'),
            autoload: true,
        });
    }

    public static async getInstance(): Promise<CrawlStore> {
        if (!CrawlStore.instance) {
            CrawlStore.instance = new CrawlStore();
        }
        return CrawlStore.instance;
    }

    private async hashString(str: string): Promise<string> {
        return await sha256(str);
    }

    public async add(url: string, rawHtml: string, content: string, depth: number): Promise<boolean> {
        if (!isContentUseful(content)) return false;

        const { strippedUrl } = extractQueryParams(url);
        const contentHash = await this.hashString(content);
        const urlHash = await this.hashString(strippedUrl);

        try {
            const newEntry: StoredCrawlData = {
                urlHash,
                url: strippedUrl,
                contentHash,
                timestamp: Date.now(),
                content: content,
                depth: depth,
                ingested: false, // Initialize as not ingested
            };

            const currentCount = await this.size();
            if (currentCount >= this.MAX_ITEMS) {
                await this.removeOldestEntries(1);
            }


            return new Promise((resolve, reject) => {
                this.db.insert(newEntry, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(true);
                    }
                });
            });
        } catch (error) {
            console.error("Error adding entry:", error);
            return false;
        }
    }

    public async markAsIngested(url: string): Promise<boolean> {
        const { strippedUrl } = extractQueryParams(url);
        const urlHash = await this.hashString(strippedUrl);

        return new Promise((resolve, reject) => {
            this.db.update({ urlHash }, { $set: { ingested: true } }, {}, (err, numReplaced) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(numReplaced > 0);
                }
            });
        });
    }

    public async getUnIngested(): Promise<StoredCrawlData[]> {
        return new Promise((resolve, reject) => {
            this.db.find({ ingested: false }, (err, docs) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(docs as StoredCrawlData[]);
                }
            });
        });
    }

    private async removeOldestEntries(count: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.find({}).sort({ timestamp: 1 }).limit(count).exec((err, docs) => {
                if (err) {
                    reject(err);
                } else {
                    const removePromises = docs.map(doc =>
                        new Promise((resolve, reject) => {
                            this.db.remove({ _id: doc._id }, {}, (err) => {
                                if (err) reject(err);
                                else resolve();
                            });
                        })
                    );
                    Promise.all(removePromises).then(() => resolve()).catch(reject);
                }
            });
        });
    }

    public async get(url: string): Promise<StoredCrawlData | null> {
        const { strippedUrl } = extractQueryParams(url);
        const urlHash = await this.hashString(strippedUrl);
        return new Promise((resolve, reject) => {
            this.db.findOne({ urlHash }, (err, doc) => {
                if (err) {
                    reject(err);
                } else {
                    if (doc && !doc.content) {
                        console.log(`Content for URL ${url} has expired.`);
                    }
                    resolve(doc as StoredCrawlData | null);
                }
            });
        });
    }

    public async has(url: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            this.db.findOne({ url }, (err, doc) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(!!doc);
                }
            });
        });
    }

    public async getAll(): Promise<StoredCrawlData[]> {
        return new Promise((resolve, reject) => {
            this.db.find({}, (err, docs) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(docs as StoredCrawlData[]);
                }
            });
        });
    }

    public async clear(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.remove({}, { multi: true }, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    public async size(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.db.count({}, (err, count) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(count);
                }
            });
        });
    }
}