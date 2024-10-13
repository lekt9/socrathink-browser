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
    lastModified: string | null;
    ingested: boolean;
}

export class CrawlStore {
    private static instance: CrawlStore;
    private db: Datastore;
    private memoryStore: StoredCrawlData[] = [];
    private readonly MAX_ITEMS = 5000;
    private readonly MEMORY_STORE_SIZE = 100;

    private constructor() {
        this.db = new Datastore({
            filename: getPath('storage/crawl_db.db'),
            autoload: true,
        });

        // Ensure that the 'url' field is unique to prevent duplicates
        this.db.ensureIndex({ fieldName: 'url', unique: true }, (err) => {
            if (err) {
                console.error('Error creating unique index on url:', err);
            } else {
                console.log('Unique index on url ensured.');
                // After ensuring the index, remove any existing duplicates
                this.removeDuplicateUrls().then(() => {
                    console.log('Duplicate URLs purged successfully.');
                }).catch((error) => {
                    console.error('Error purging duplicate URLs:', error);
                });
            }
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

    public async add(
        url: string,
        rawHtml: string,
        content: string,
        depth: number,
        lastModified: string | null,
        p0: (err: { message: any; }) => void
    ): Promise<boolean> {
        if (!isContentUseful(content)) return false;

        const { strippedUrl } = extractQueryParams(url);
        const contentHash = await this.hashString(content);
        const urlHash = await this.hashString(strippedUrl);

        try {
            // Check if the URL already exists
            const existingEntry = await this.get(url);
            if (existingEntry) {
                console.log(`URL ${url} already exists in the database.`);
                return false;
            }

            const newEntry: StoredCrawlData = {
                urlHash,
                url,
                contentHash,
                timestamp: Date.now(),
                content: content.slice(0, 200000), // cap to a max length
                depth: depth,
                lastModified: lastModified ?? null,
                ingested: false, // Initialize as not ingested
            };

            if (this.memoryStore.length < this.MEMORY_STORE_SIZE) {
                this.memoryStore.push(newEntry);
                this.sortMemoryStore();
            } else {
                const currentCount = await this.size();
                if (currentCount >= this.MAX_ITEMS) {
                    await this.removeOldestEntries(1);
                }

                if (!content) {
                    console.log(`Content for URL ${url} is null. Skipping insertion.`);
                    return false;
                }

                return new Promise((resolve, reject) => {
                    try {
                        this.db.insert(newEntry, (err: any) => {
                            if (err) {
                                if (err.errorType === 'uniqueViolated') {
                                    console.log(`Duplicate URL detected during insertion: ${url}.`);
                                    resolve(false);
                                } else {
                                    reject(err);
                                }
                            } else {
                                resolve(true);
                            }
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }

            return true;
        } catch (error) {
            console.error("Error adding entry:", error);
            return false;
        }
    }

    private sortMemoryStore(): void {
        this.memoryStore.sort((a, b) => b.timestamp - a.timestamp);
    }

    public async markAsIngested(url: string): Promise<boolean> {
        const memoryIndex = this.memoryStore.findIndex(item => item.url === url);
        if (memoryIndex !== -1) {
            this.memoryStore[memoryIndex].ingested = true;
            this.memoryStore[memoryIndex].content = null;
            return true;
        }

        return new Promise((resolve, reject) => {
            this.db.update({ url }, { $set: { ingested: true, content: null } }, {}, (err: any, numReplaced: number) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(numReplaced > 0);
                }
            });
        });
    }

    public async getUnIngested(): Promise<StoredCrawlData[]> {
        const memoryUnIngested = this.memoryStore.filter(item => !item.ingested);

        return new Promise((resolve, reject) => {
            this.db.find({ ingested: false }, (err: any, docs: StoredCrawlData[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve([...memoryUnIngested, ...docs]);
                }
            });
        });
    }

    private async removeOldestEntries(count: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.find({}).sort({ timestamp: 1 }).limit(count).exec((err: any, docs: any[]) => {
                if (err) {
                    reject(err);
                } else {
                    const removePromises = docs.map((doc: { _id: any; }) =>
                        new Promise<void>((resolve, reject) => {
                            this.db.remove({ _id: doc._id }, {}, (err: any) => {
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

    /**
     * Removes duplicate URLs from the database, keeping the most recent entry.
     */
    private async removeDuplicateUrls(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.find({}).sort({ url: 1, timestamp: -1 }).exec(async (err: any, docs: StoredCrawlData[]) => {
                if (err) {
                    reject(err);
                } else {
                    const urlMap: Record<string, StoredCrawlData> = {};
                    const duplicates: string[] = [];

                    for (const doc of docs) {
                        if (urlMap[doc.url]) {
                            duplicates.push(doc._id);
                        } else {
                            urlMap[doc.url] = doc;
                        }
                    }

                    if (duplicates.length === 0) {
                        resolve();
                        return;
                    }

                    const removePromises = duplicates.map((id) =>
                        new Promise<void>((res, rej) => {
                            this.db.remove({ _id: id }, {}, (removeErr: any) => {
                                if (removeErr) rej(removeErr);
                                else res();
                            });
                        })
                    );

                    Promise.all(removePromises).then(() => resolve()).catch(reject);
                }
            });
        });
    }

    public async get(url: string): Promise<StoredCrawlData | null> {
        const memoryItem = this.memoryStore.find(item => item.url === url);
        if (memoryItem) return memoryItem;

        return new Promise((resolve, reject) => {
            this.db.findOne({ url }, (err: any, doc: StoredCrawlData) => {
                if (err || !doc) {
                    resolve(null);
                } else {
                    resolve(doc as StoredCrawlData | null);
                }
            });
        });
    }

    public async has(url: string): Promise<boolean> {
        if (this.memoryStore.some(item => item.url === url)) return true;

        return new Promise((resolve, reject) => {
            this.db.findOne({ url }, (err: any, doc: any) => {
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
            this.db.find({}, (err: any, docs: StoredCrawlData[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve([...this.memoryStore, ...docs]);
                }
            });
        });
    }

    public async clear(): Promise<void> {
        this.memoryStore = [];
        return new Promise((resolve, reject) => {
            this.db.remove({}, { multi: true }, (err: any) => {
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
            this.db.count({}, (err: any, count: number | PromiseLike<number>) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.memoryStore.length + count);
                }
            });
        });
    }
}