import { createRxDatabase, RxDatabase, RxCollection, RxJsonSchema, RxCollectionCreator } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { StoredCrawlData } from './crawl-store';
import { StoredNetworkData } from './network-store';

export type CrawlsCollection = RxCollection<StoredCrawlData>;
export type NetworkCollection = RxCollection<StoredNetworkData>;
export type DomainStatusCollection = RxCollection<DomainStatusDocType>;

export type MyDatabaseCollections = {
    crawls: CrawlsCollection;
    network: NetworkCollection;
    domainStatus: DomainStatusCollection;
};

const crawlSchema: RxJsonSchema<StoredCrawlData> = {
    version: 0,
    type: 'object',
    primaryKey: 'urlHash',
    properties: {
        urlHash: {
            type: 'string',
            maxLength: 255
        },
        url: {
            type: 'string',
            maxLength: 2000
        },
        contentHash: {
            type: 'string',
            maxLength: 255
        },
        timestamp: {
            type: 'integer',
            minimum: 0
        },
        content: {
            type: 'string',
            maxLength: 2000,
        },
        depth: {
            type: 'integer',
            minimum: 0
        }
    },
    required: ['urlHash', 'url', 'contentHash', 'timestamp', 'depth']
};

const networkSchema: RxJsonSchema<StoredNetworkData> = {
    version: 0,
    type: 'object',
    primaryKey: 'requestId',
    properties: {
        requestId: {
            type: 'string',
            maxLength: 255
        },
        urlHash: {
            type: 'string',
            maxLength: 255
        },
        baseUrl: {
            type: 'string',
            maxLength: 2000
        },
        path: {
            type: 'string',
            maxLength: 2000
        },
        queryParams: {
            type: 'object',
            additionalProperties: { type: 'string' }
        },
        pathParams: {
            type: 'array',
            items: { type: 'string' }
        },
        method: {
            type: 'string'
        },
        requestHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' }
        },
        requestBody: {
            type: 'string',
            maxLength: 2000
        },
        responseStatus: {
            type: 'integer'
        },
        responseHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' }
        },
        responseBody: {
            type: 'string',
            maxLength: 2000
        },
        contentHash: {
            type: 'string',
            maxLength: 255
        },
        timestamp: {
            type: 'integer',
            minimum: 0
        },
        parentUrlHash: {
            type: 'string',
            maxLength: 255
        }
    },
    required: ['requestId', 'urlHash', 'baseUrl', 'path', 'method', 'requestHeaders', 'responseStatus', 'responseHeaders', 'contentHash', 'timestamp']
};

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

export async function createDatabase(): Promise<RxDatabase<MyDatabaseCollections>> {
    const db = await createRxDatabase<MyDatabaseCollections>({
        name: 'crawldb',
        storage: getRxStorageMemory()
    });

    const collections: { [key in keyof MyDatabaseCollections]: RxCollectionCreator } = {
        crawls: {
            schema: crawlSchema
        },
        network: {
            schema: networkSchema
        },
        domainStatus: {
            schema: domainStatusSchema
        }
    };

    await db.addCollections(collections);

    return db;
}

export interface DomainStatusDocType {
    domain: string;
    isCompleted: boolean;
}