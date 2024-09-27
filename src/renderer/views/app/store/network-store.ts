import { CrawlsCollection, createDatabase, NetworkCollection, ToolsCollection } from './rxdb-setup';
import { RxDatabase, RxJsonSchema } from 'rxdb';
// Removed Embedding imports and plugins
import { sha256 } from 'hash-wasm';
import { EndpointCollector, StorableTool } from './tools'
// New file for ToolStore if separated, alternatively integrate into network-store.ts


export const toolSchema: RxJsonSchema<StorableTool> = {
  version: 0,
  type: 'object',
  primaryKey: 'name',
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
                additionalProperties: {
                  type: 'string',
                  enum: ['enum', 'dynamic']
                }
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
/**
 * Utility function to calculate the Euclidean distance between two vectors.
 * @param a First vector.
 * @param b Second vector.
 * @returns The Euclidean distance.
 */
function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must be of the same length');
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Utility function to sort an array of objects by a numeric property.
 * @param prop The property name to sort by.
 * @returns A comparator function.
 */
function sortByObjectNumberProperty(prop: string) {
  return (a: any, b: any) => {
    return a[prop] - b[prop];
  };
}

/**
 * Utility function to convert a number to a fixed-length string with leading zeros.
 * @param num The number to convert.
 * @param length The desired string length.
 * @returns The fixed-length string.
 */
function indexNrToString(num: number, length: number = 10): string {
  return num.toFixed(6).padStart(length, '0');
}

/**
 * Interface for storing network data.
 */
export interface StoredNetworkData {
  requestId: string;
  urlHash: string;
  baseUrl: string;
  url: string;
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
}

/**
 * Class representing the network store with tool management capabilities.
 */
export class NetworkStore {
  private static instance: NetworkStore;
  private db: RxDatabase<{
    network: NetworkCollection,
    crawls: CrawlsCollection,
    tools: ToolsCollection,
  }>;
  private readonly MAX_ITEMS = 2000;
  private sampleVectors: number[][] = [
    // Existing sample vectors if any
  ];

  private constructor(db: RxDatabase<{
    network: NetworkCollection,
    crawls: CrawlsCollection,
    tools: ToolsCollection,
  }>) {
    this.db = db;
  }

  /**
   * Retrieves the singleton instance of NetworkStore.
   */
  public static async getInstance(): Promise<NetworkStore> {
    if (!NetworkStore.instance) {
      const db = await createDatabase();
      NetworkStore.instance = new NetworkStore(db);
    }
    return NetworkStore.instance;
  }

  /**
   * Hashes a given string using SHA-256.
   */
  async hashString(str: string): Promise<string> {
    return await sha256(str);
  }

  /**
   * Adds a GET request to the network log with parsed path and query parameters.
   * Returns the stored entry for mapping purposes.
   */
  public async addRequestToLog(details: { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string; initiator: any }): Promise<StoredNetworkData | null> {
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
      url: details.url,
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
      // const currentCount = await this.size();
      // if (currentCount >= this.MAX_ITEMS) {
      //   await this.removeOldestEntries(1);
      // }
      console.log(newEntry);

      await this.db.network.insert(newEntry);

      return newEntry;
    } catch (error) {
      console.error('Error adding network request to log:', error);
      return null;
    }
  }

  /**
   * Updates a network log entry with response details.
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
      }
    } catch (error) {
      console.error('Error updating network log with response:', error);
    }
  }

  /**
   * Clears all network logs.
   */
  public async clearLogs(): Promise<void> {
    await this.db.network.remove();
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
  private extractPathParams(path: string): string[] | undefined {
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
   * Retrieves all tools from the tools collection.
   */
  public async getTools(): Promise<StorableTool[]> {
    const pairs = await this.db.network.find({
      selector: {
        responseStatus: { $gt: 0 },
        responseBody: { $exists: true }
      }
    }).exec();

    const collector = new EndpointCollector();

    for (const pair of pairs) {
      try {
        const parsedResponseBody = JSON.parse(pair.responseBody);
        collector.processEndpoint({
          url: pair.url,
          requestPayload: pair.requestBody,
          responsePayload: pair.responseBody,
        });
      } catch (error) {
        console.log(`Error processing endpoint: ${pair.url}`, error);
      }
    }

    const tools = collector.getTools().filter(tool => tool.endpoints.length > 1);

    return tools;
  }
}