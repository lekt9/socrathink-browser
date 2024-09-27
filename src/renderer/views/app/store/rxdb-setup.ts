import { createRxDatabase, RxDatabase, RxCollection, RxJsonSchema, RxCollectionCreator } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { StoredCrawlData } from './crawl-store';
import { StoredNetworkData, ToolDocument } from './network-store';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

export type CrawlsCollection = RxCollection<StoredCrawlData>;
export type NetworkCollection = RxCollection<StoredNetworkData>;
export type ToolsCollection = RxCollection<ToolDocument>; // New collection type

export type MyDatabaseCollections = {
    crawls: CrawlsCollection;
    network: NetworkCollection;
    tools: ToolsCollection; // Added Tools collection
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
        url: { type: 'string', maxLength: 255 },
        baseUrl: { type: 'string', maxLength: 255 },
        path: { type: 'string', maxLength: 255 },
        queryParams: {
            type: 'object',
            additionalProperties: { type: 'string' },
            maxProperties: 100
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

const toolSchema: RxJsonSchema<ToolDocument> = { // New schema for ToolDocument
    version: 0,
    type: 'object',
    primaryKey: 'name', // Assuming 'name' is unique for each tool
    properties: {
        name: { type: 'string', maxLength: 255 },
        pattern: { type: 'string', maxLength: 1000 },
        endpoints: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    url: { type: 'string', maxLength: 2000 },
                    requestPayload: { type: 'object' },
                    responsePayload: { type: 'object' },
                    pathInfo: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', maxLength: 1000 },
                            queryParams: {
                                type: 'object',
                                additionalProperties: { type: 'string' },
                            },
                        },
                        required: ['path', 'queryParams'],
                    },
                },
                required: ['url', 'requestPayload', 'responsePayload', 'pathInfo'],
            },
        },
        queryParamOptions: {
            type: 'object',
            additionalProperties: {
                type: 'array',
                items: { type: 'string' },
            },
        },
    },
    required: ['name', 'pattern', 'endpoints', 'queryParamOptions'],
};


export async function createDatabase(): Promise<RxDatabase<MyDatabaseCollections>> {
    const db = await createRxDatabase<MyDatabaseCollections>({
        name: 'albert',
        storage: getRxStorageMemory(),
        // storage: getRxStorageDexie(),
        ignoreDuplicate: true
    });
    const collections: { [key in keyof MyDatabaseCollections]: RxCollectionCreator } = {
        crawls: {
            schema: crawlSchema,
        },
        network: {
            schema: networkSchema,
        },
        tools: { // Added Tools collection
            schema: toolSchema,
        },
    };

    await db.addCollections(collections);

    return db;
}
