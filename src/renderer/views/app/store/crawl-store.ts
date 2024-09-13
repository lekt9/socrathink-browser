import { createDatabase, CrawlsCollection, DomainStatusCollection } from './rxdb-setup';
import { addRxPlugin, RxDatabase } from 'rxdb';
import { isContentUseful } from '~/utils/parse';
import { RxDBUpdatePlugin } from 'rxdb/plugins/update';
import { extractQueryParams } from '~/utils/url';
import { sha256 } from 'hash-wasm';

addRxPlugin(RxDBUpdatePlugin);

export interface StoredCrawlData {
    urlHash: string;
    url: string;
    contentHash: string;
    timestamp: number;
    content?: string;
    depth: number;
    // permutations: Record<string, string>[];
}

export interface DomainStatus {
    domain: string;
    isCompleted: boolean;
}

export class CrawlStore {
    private static instance: CrawlStore;
    private db: RxDatabase<{
        crawls: CrawlsCollection;
        domainStatus: DomainStatusCollection;
    }>;
    private requestCount: number = 0;

    private constructor() { }

    public static async getInstance(): Promise<CrawlStore> {
        if (!CrawlStore.instance) {
            CrawlStore.instance = new CrawlStore();
            await CrawlStore.instance.initialize();
        }
        return CrawlStore.instance;
    }

    private async initialize(): Promise<void> {
        this.db = await createDatabase();
    }

    private getDomainFromUrl(url: string): string {
        return new URL(url).hostname;
    }

    private stripQueryParams(url: string): string {
        try {
            const urlObj = new URL(url);
            return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
        }
        catch {
            return url;
        }
    }

    private async hashString(str: string): Promise<string> {
        return await sha256(str);
    }

    // private updatePermutations(existingPermutations: Record<string, string>[], newParams: Record<string, string>): Record<string, string>[] {
    //     if (!existingPermutations.some(p => JSON.stringify(p) === JSON.stringify(newParams))) {
    //         existingPermutations.push(newParams);
    //     }
    //     return existingPermutations;
    // }

    public async add(url: string, rawHtml: string, content: string, depth: number, jsonResponse?: object): Promise<boolean> {
        if (!isContentUseful(content)) return false;
        console.log("content useful", content);
        const domain = this.getDomainFromUrl(url);
        if (!domain) return false;

        const { strippedUrl, params } = extractQueryParams(url);
        const contentHash = await this.hashString(content); // Hash the raw HTML instead of processed content

        const urlHash = await this.hashString(strippedUrl);

        try {
            const newEntry: StoredCrawlData = {
                urlHash,
                url: strippedUrl,
                contentHash,
                timestamp: Date.now(),
                content: content, // Store the processed content
                depth: depth,
            };
            await this.db.crawls.insert(newEntry);

            console.log("Stored new entry", newEntry);

            return true;
        } catch (error) {
            console.error("Error adding entry:", error);
            return false;
        }
    }

    public async get(url: string): Promise<StoredCrawlData | null> {
        const { strippedUrl } = extractQueryParams(url);
        const urlHash = await this.hashString(strippedUrl);
        const result = await this.db.crawls.findOne({ selector: { urlHash } }).exec();
        if (result) {
            const data = result.toJSON();
            if (!data.content) {
                console.log(`Content for URL ${url} has expired.`);
            }
            return data as StoredCrawlData;
        }
        return null;
    }

    public async has(url: string): Promise<boolean> {
        const result = await this.db.crawls.findOne({ selector: { url } }).exec();
        return !!result;
    }

    public async getAll(): Promise<StoredCrawlData[]> {
        const results = await this.db.crawls.find().exec();
        return results.map(doc => doc.toJSON() as StoredCrawlData);
    }

    public async clear(): Promise<void> {
        await this.db.crawls.remove();
    }

    public async size(): Promise<number> {
        return await this.db.crawls.count().exec();
    }
}