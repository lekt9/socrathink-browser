import { createRxDatabase, RxDatabase, RxCollection, RxJsonSchema, RxCollectionCreator } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { StoredCrawlData } from './crawl-store';
import { StoredNetworkData } from './network-store';

export type CrawlsCollection = RxCollection<StoredCrawlData>;
export type NetworkCollection = RxCollection<StoredNetworkData>;
export type DomainStatusCollection = RxCollection<DomainStatusDocType>;
export type EmbeddingsCollection = RxCollection<EmbeddingDocument>;

export type MyDatabaseCollections = {
    crawls: CrawlsCollection;
    network: NetworkCollection;
    domainStatus: DomainStatusCollection;
    embeddings: EmbeddingsCollection;
};

const crawlSchema: RxJsonSchema<StoredCrawlData> = {
    version: 0,
    type: 'object',
    primaryKey: 'urlHash',
    properties: {
        urlHash: { type: 'string', maxLength: 255 },
        url: { type: 'string', maxLength: 2000 },
        contentHash: { type: 'string', maxLength: 255 },
        timestamp: { type: 'integer', minimum: 0 },
        content: { type: 'string', maxLength: 2000 },
        depth: { type: 'integer', minimum: 0 },
    },
    required: ['urlHash', 'url', 'contentHash', 'timestamp', 'depth'],
};

const networkSchema: RxJsonSchema<StoredNetworkData> = {
    version: 0,
    type: 'object',
    primaryKey: 'requestId',
    properties: {
        requestId: { type: 'string', maxLength: 255 },
        urlHash: { type: 'string', maxLength: 255 },
        baseUrl: { type: 'string', maxLength: 2000 },
        path: { type: 'string', maxLength: 2000 },
        queryParams: {
            type: 'object',
            additionalProperties: { type: 'string' },
        },
        pathParams: {
            type: 'array',
            items: { type: 'string' },
        },
        method: { type: 'string' },
        requestHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' },
        },
        requestBody: { type: 'string', maxLength: 2000 },
        responseStatus: { type: 'integer' },
        responseHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' },
        },
        responseBody: { type: 'string', maxLength: 2000 },
        contentHash: { type: 'string', maxLength: 255 },
        timestamp: { type: 'integer', minimum: 0 },
        parentUrlHash: { type: 'string', maxLength: 255 },
    },
    required: [
        'requestId',
        'urlHash',
        'baseUrl',
        'path',
        'method',
        'requestHeaders',
        'responseStatus',
        'responseHeaders',
        'contentHash',
        'timestamp',
    ],
};

const embeddingsSchema: RxJsonSchema<EmbeddingDocument> = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id: { type: 'string', maxLength: 100 },
        baseUrl: { type: 'string' },
        path: { type: 'string' },
        embedding: {
            type: 'array',
            items: { type: 'number' },
        },
        idx0: { type: 'string', maxLength: 10 },
        idx1: { type: 'string', maxLength: 10 },
        idx2: { type: 'string', maxLength: 10 },
        idx3: { type: 'string', maxLength: 10 },
        idx4: { type: 'string', maxLength: 10 },
    },
    required: ['id', 'baseUrl', 'path', 'idx0', 'idx1', 'idx2', 'idx3', 'idx4'],
    indexes: ['idx0', 'idx1', 'idx2', 'idx3', 'idx4'],
};

export interface DomainStatusDocType {
    domain: string;
    isCompleted: boolean;
}

export interface EmbeddingDocument {
    id: string;
    baseUrl: string;
    path: string;
    embedding?: number[];
    idx0: string;
    idx1: string;
    idx2: string;
    idx3: string;
    idx4: string;
}

export async function createDatabase(): Promise<RxDatabase<MyDatabaseCollections>> {
    const db = await createRxDatabase<MyDatabaseCollections>({
        name: 'mydatabase',
        storage: getRxStorageDexie(),
    });

    const collections: { [key in keyof MyDatabaseCollections]: RxCollectionCreator } = {
        crawls: {
            schema: crawlSchema,
        },
        network: {
            schema: networkSchema,
        },
        domainStatus: {
            schema: domainStatusSchema,
        },
        embeddings: {
            schema: embeddingsSchema,
        },
    };

    await db.addCollections(collections);

    return db;
}