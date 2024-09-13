import { createRxDatabase, RxDatabase, RxCollection, RxJsonSchema } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { StoredCrawlData } from './crawl-store';

export type CrawlsCollection = RxCollection<StoredCrawlData>;

const crawlSchema: RxJsonSchema<StoredCrawlData> = {
    version: 0,
    type: 'object',
    primaryKey: 'urlHash',
    properties: {
        urlHash: {
            type: 'string',
            maxLength: 255  // Add a reasonable max length
        },
        url: {
            type: 'string',
            maxLength: 2000  // Add a reasonable max length
        },
        contentHash: {
            type: 'string',
            maxLength: 255  // Add a reasonable max length
        },
        timestamp: {
            type: 'integer',
            minimum: 0
        },
        content: {
            type: 'string',
            maxLength: 2000,
        }
    },
    required: ['urlHash', 'url', 'contentHash', 'timestamp']
};

export async function createDatabase(): Promise<RxDatabase<{ crawls: CrawlsCollection, domainStatus: DomainStatusCollection }>> {
    const db = await createRxDatabase<{ crawls: CrawlsCollection }>({
        name: 'crawldb',
        storage: getRxStorageMemory()
    });

    await db.addCollections({
        crawls: {
            schema: crawlSchema
        },
    })
    await db.addCollections({
        domainStatus: {
            schema: domainStatusSchema
        }
    })


    return db;
}


// Define the interface for a DomainStatus document
export interface DomainStatusDocType {
    domain: string;
    isCompleted: boolean;
}

// Define the schema for the DomainStatus collection
const domainStatusSchema: RxJsonSchema<DomainStatusDocType> = {
    version: 0,
    type: 'object',
    primaryKey: 'domain',
    properties: {
        domain: {
            type: 'string'
        },
        isCompleted: {
            type: 'boolean'
        }
    },
    required: ['domain', 'isCompleted']
};

// Define the DomainStatusCollection type
export type DomainStatusCollection = RxCollection<DomainStatusDocType>;
