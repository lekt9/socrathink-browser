import { CrawlsCollection, createDatabase, DomainStatusCollection, NetworkCollection } from './rxdb-setup';
import { addRxPlugin, createRxDatabase, RxDatabase } from 'rxdb';
import { RxDBUpdatePlugin } from 'rxdb/plugins/update';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import { pipeline } from "@xenova/transformers";
import { euclideanDistance } from 'rxdb/plugins/vector';
import { sortByObjectNumberProperty } from 'rxdb/plugins/core';
import { sha256 } from 'hash-wasm';

addRxPlugin(RxDBUpdatePlugin);

/**
 * Interface for storing network data.
 */
export interface StoredNetworkData {
  requestId: string;
  urlHash: string;
  baseUrl: string;
  path: string;
  queryParams?: Record<string, string>;
  pathParams?: string[];
  method: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  contentHash: string;
  timestamp: number;
  parentUrlHash?: string;
  embedding?: number[]; // Added embedding field
}

/**
 * Interface for embedding documents.
 */
interface EmbeddingDocument {
  id: string;
  baseUrl: string;
  path: string;
  embedding: number[];
}

/**
 * Class representing the network store with search capabilities.
 */
export class NetworkStore {
  private static instance: NetworkStore;
  private db: RxDatabase<{
    crawls: CrawlsCollection,
    network: NetworkCollection,
    domainStatus: DomainStatusCollection,
    embeddings: { schema: any }
  }>;
  private readonly MAX_ITEMS = 200;
  private pipePromise: Promise<any>;

  private constructor() {
    this.pipePromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }

  /**
   * Retrieves the singleton instance of NetworkStore.
   */
  public static async getInstance(): Promise<NetworkStore> {
    if (!NetworkStore.instance) {
      NetworkStore.instance = new NetworkStore();
      await NetworkStore.instance.initialize();
    }
    return NetworkStore.instance;
  }

  /**
   * Initializes the RxDB database and collections.
   */
  private async initialize(): Promise<void> {
    this.db = await createRxDatabase({
      name: 'mydatabase',
      storage: getRxStorageDexie()
    });

    await this.db.addCollections({
      crawls: {
        schema: {
          // Define your crawls schema here
        }
      },
      network: {
        schema: {
          version: 0,
          primaryKey: 'requestId',
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            urlHash: { type: 'string' },
            baseUrl: { type: 'string' },
            path: { type: 'string' },
            queryParams: { type: 'object' },
            pathParams: { type: 'array', items: { type: 'string' } },
            method: { type: 'string' },
            requestHeaders: { type: 'object' },
            requestBody: { type: 'string' },
            responseStatus: { type: 'number' },
            responseHeaders: { type: 'object' },
            responseBody: { type: 'string' },
            contentHash: { type: 'string' },
            timestamp: { type: 'number' },
            parentUrlHash: { type: 'string' },
            embedding: { type: 'array', items: { type: 'number' }, optional: true }
          },
          required: ['requestId', 'urlHash', 'baseUrl', 'path', 'method', 'requestHeaders', 'responseStatus', 'responseHeaders', 'contentHash', 'timestamp']
        }
      },
      domainStatus: {
        schema: {
          // Define your domainStatus schema here
        }
      },
      embeddings: {
        schema: {
          version: 0,
          primaryKey: 'id',
          type: 'object',
          properties: {
            id: { type: 'string' },
            baseUrl: { type: 'string' },
            path: { type: 'string' },
            embedding: { type: 'array', items: { type: 'number' } }
          },
          required: ['id', 'baseUrl', 'path', 'embedding']
        }
      }
    });
  }

  /**
   * Hashes a given string using SHA-256.
   */
  async hashString(str: string): Promise<string> {
    return await sha256(str);
  }

  /**
   * Adds a GET request to the network log with parsed path and query parameters.
   * Generates and stores embeddings for baseUrl, requestBody, and responseBody.
   * Returns the stored entry for mapping purposes.
   */
  public async addRequestToLog(details: { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string; initiator: any }): Promise<StoredNetworkData> {
    if (details.method.toUpperCase() !== 'GET') return null; // Focus only on GET requests

    const urlHash = await this.hashString(details.url);
    const urlObj = new URL(details.url);
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? `:${urlObj.port}` : ''}`;
    const path = urlObj.pathname;
    const queryParams: Record<string, string> = {};
    urlObj.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    // Extract path parameters (e.g., /api/stocks/123 -> ["param3"])
    const pathParams = this.extractPathParams(path);

    const newEntry: StoredNetworkData = {
      requestId: details.requestId,
      urlHash,
      baseUrl,
      path,
      queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
      pathParams,
      method: details.method,
      requestHeaders: details.headers,
      requestBody: details.body,
      responseStatus: 0, // Placeholder, to be updated on response received
      responseHeaders: {},
      responseBody: undefined,
      contentHash: '',
      timestamp: Date.now(),
      parentUrlHash: details.initiator?.urlHash
    };

    try {
      const currentCount = await this.size();
      if (currentCount >= this.MAX_ITEMS) {
        await this.removeOldestEntries(1);
      }

      // Generate embedding for baseUrl and requestBody if available
      const embedding = await this.generateEmbedding(newEntry);
      newEntry.embedding = embedding;

      await this.db.network.insert(newEntry);

      // Store embedding separately for search
      if (embedding) {
        const embeddingDoc: EmbeddingDocument = {
          id: newEntry.requestId,
          baseUrl: newEntry.baseUrl,
          path: newEntry.path,
          embedding
        };
        await this.db.embeddings.insert(embeddingDoc);
      }

      return newEntry;
    } catch (error) {
      console.error('Error adding network request to log:', error);
      return null;
    }
  }

  /**
   * Updates a network log entry with response details and regenerates embedding.
   */
  public async updateLogWithResponse(details: { requestId: string; status: number; headers: Record<string, string>; body?: string }): Promise<void> {
    try {
      const entry = await this.db.network.findOne({ selector: { requestId: details.requestId } }).exec();
      if (entry) {
        const rawBody = details.body || '';
        const contentHash = await this.hashString(rawBody);
        const updatedEntry = {
          responseStatus: details.status,
          responseHeaders: details.headers,
          responseBody: rawBody,
          contentHash,
        };
        await entry.update({ $set: updatedEntry });

        // Update embedding with responseBody
        const updatedEntryData = entry.toJSON() as StoredNetworkData;
        const newEmbedding = await this.generateEmbedding(updatedEntryData);
        updatedEntryData.embedding = newEmbedding;
        await entry.update({ $set: { embedding: newEmbedding } });

        // Update embedding document
        if (newEmbedding) {
          const embeddingDoc: EmbeddingDocument = {
            id: updatedEntryData.requestId,
            baseUrl: updatedEntryData.baseUrl,
            path: updatedEntryData.path,
            embedding: newEmbedding
          };
          const existingEmbedding = await this.db.embeddings.findOne({ selector: { id: details.requestId } }).exec();
          if (existingEmbedding) {
            await existingEmbedding.update({ $set: embeddingDoc });
          } else {
            await this.db.embeddings.insert(embeddingDoc);
          }
        }
      }
    } catch (error) {
      console.error('Error updating network log with response:', error);
    }
  }

  /**
   * Generates embedding for baseUrl, requestBody, and responseBody.
   */
  private async generateEmbedding(entry: StoredNetworkData): Promise<number[] | null> {
    try {
      const pipe = await this.pipePromise;
      let textToEmbed = entry.baseUrl;
      if (entry.requestBody) {
        textToEmbed += ` ${entry.requestBody}`;
      }
      if (entry.responseBody) {
        textToEmbed += ` ${entry.responseBody}`;
      }
      const output = await pipe(textToEmbed, {
        pooling: "mean",
        normalize: true,
      });
      return Array.from(output.data);
    } catch (error) {
      console.error('Error generating embedding:', error);
      return null;
    }
  }

  /**
   * Removes the oldest entries to maintain the maximum limit.
   */
  private async removeOldestEntries(count: number): Promise<void> {
    const oldestEntries = await this.db.network.find()
      .sort({ timestamp: 'asc' })
      .limit(count)
      .exec();

    for (const entry of oldestEntries) {
      await entry.remove();
      // Also remove from embeddings collection
      await this.db.embeddings.findOne({ selector: { id: entry.requestId } }).exec()?.remove();
    }
  }

  /**
   * Clears all network logs and embeddings.
   */
  public async clearLogs(): Promise<void> {
    await this.db.network.remove();
    await this.db.embeddings.remove();
  }

  /**
   * Retrieves a specific network log entry by requestId.
   */
  public async get(requestId: string): Promise<StoredNetworkData | null> {
    const result = await this.db.network.findOne({ selector: { requestId } }).exec();
    return result ? result.toJSON() as StoredNetworkData : null;
  }

  /**
   * Checks if a requestId exists in the network logs.
   */
  public async has(requestId: string): Promise<boolean> {
    const result = await this.db.network.findOne({ selector: { requestId } }).exec();
    return !!result;
  }

  /**
   * Retrieves all network log entries.
   */
  public async getAll(): Promise<StoredNetworkData[]> {
    const results = await this.db.network.find().exec();
    return results.map(doc => doc.toJSON() as StoredNetworkData);
  }

  /**
   * Gets the current number of network log entries.
   */
  public async size(): Promise<number> {
    return await this.db.network.count().exec();
  }

  /**
   * Extracts path parameters from a URL path.
   * Assumes path parameters are segments that are numeric or UUIDs.
   * Modify this logic based on your API's path parameter patterns.
   */
  private extractPathParams(path: string): string[] {
    const segments = path.split('/').filter(Boolean);
    const params: string[] = [];

    segments.forEach((segment, index) => {
      if (this.isDynamicSegment(segment)) {
        // Example: If the segment is dynamic, name it based on its position
        params.push(`param${index}`);
      }
    });

    return params.length > 0 ? params : undefined;
  }

  /**
   * Determines if a path segment is dynamic.
   * Modify this logic based on how your API defines dynamic segments.
   */
  private isDynamicSegment(segment: string): boolean {
    // Example: Consider segments that are numbers or UUIDs as dynamic
    const uuidRegex = /^[0-9a-fA-F-]{36}$/;
    const numberRegex = /^\d+$/;
    return uuidRegex.test(segment) || numberRegex.test(segment);
  }

  /**
   * Generates a JSON schema for a specific endpoint based on collected network data.
   * @param baseUrl The base URL of the API (e.g., 'https://api.example.com').
   * @param path The specific endpoint path (e.g., '/api/stocks').
   * @returns A JSON schema object or null if no data is found.
   */
  public async generateJsonSchema(baseUrl: string, path: string): Promise<any> {
    // Retrieve all GET requests for the specified endpoint
    const allEntries = await this.db.network.find({
      selector: {
        baseUrl,
        path,
        method: 'GET'
      }
    }).exec();

    if (allEntries.length === 0) {
      console.warn(`No GET requests found for ${baseUrl}${path}`);
      return null;
    }

    const allQueryParams: string[] = [];
    const allPathParams: string[] = [];

    allEntries.forEach(entry => {
      if (entry.queryParams) {
        allQueryParams.push(...Object.keys(entry.queryParams));
      }
      if (entry.pathParams) {
        allPathParams.push(...entry.pathParams);
      }
    });

    const uniqueQueryParams = Array.from(new Set(allQueryParams));
    const uniquePathParams = Array.from(new Set(allPathParams));

    // Determine required and optional query parameters
    const requiredQueryParams: string[] = [];
    uniqueQueryParams.forEach(param => {
      const isRequired = allEntries.every(entry => entry.queryParams && param in entry.queryParams);
      if (isRequired) {
        requiredQueryParams.push(param);
      }
    });

    // Assuming all path parameters are required
    const requiredPathParams = uniquePathParams;

    // Construct the JSON schema
    const schema: any = {
      type: 'object',
      properties: {}
    };

    if (uniquePathParams.length > 0) {
      schema.properties.pathParams = {
        type: 'object',
        properties: {}
      };
      uniquePathParams.forEach(param => {
        schema.properties.pathParams.properties[param] = { type: 'string' };
      });
      schema.properties.pathParams.required = requiredPathParams;
    }

    if (uniqueQueryParams.length > 0) {
      schema.properties.queryParams = {
        type: 'object',
        properties: {}
      };
      uniqueQueryParams.forEach(param => {
        schema.properties.queryParams.properties[param] = { type: 'string' };
      });
      schema.properties.queryParams.required = requiredQueryParams;
    }

    // Define the required fields in the root object
    schema.required = [];
    if (uniquePathParams.length > 0) {
      uniquePathParams.forEach(param => {
        schema.required.push(`pathParams.${param}`);
      });
    }
    if (requiredQueryParams.length > 0) {
      requiredQueryParams.forEach(param => {
        schema.required.push(`queryParams.${param}`);
      });
    }

    return schema;
  }

  /**
   * Search tool to retrieve multiple baseUrls and paths based on embeddings.
   * @param query The user input query string.
   * @param topK The number of top results to retrieve.
   * @returns An array of matching network entries.
   */
  public async searchTools(query: string, topK: number = 10): Promise<StoredNetworkData[]> {
    try {
      const queryVector = await this.getEmbeddingFromText(query);
      const candidates = await this.db.embeddings.find().exec();

      const withDistance = candidates.map(doc => ({
        doc,
        distance: euclideanDistance(queryVector, doc.embedding)
      }));

      const sorted = withDistance.sort(sortByObjectNumberProperty('distance'));

      const topResults = sorted.slice(0, topK).map(item => item.doc.id);

      const entries = await Promise.all(topResults.map(id => this.get(id)));
      return entries.filter(entry => entry !== null) as StoredNetworkData[];
    } catch (error) {
      console.error('Error during search:', error);
      return [];
    }
  }

  /**
   * Generates embedding from text using the configured pipeline.
   * @param text The input text to generate embedding for.
   * @returns An array of numbers representing the embedding.
   */
  private async getEmbeddingFromText(text: string): Promise<number[]> {
    try {
      const pipe = await this.pipePromise;
      const output = await pipe(text, {
        pooling: "mean",
        normalize: true,
      });
      return Array.from(output.data);
    } catch (error) {
      console.error('Error generating embedding from text:', error);
      return [];
    }
  }
}

export default NetworkStore.getInstance();