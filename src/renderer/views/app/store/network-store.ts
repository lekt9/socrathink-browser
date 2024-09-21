import { CrawlsCollection, createDatabase, DomainStatusCollection, NetworkCollection } from './rxdb-setup';
import { addRxPlugin, RxDatabase } from 'rxdb';
import { RxDBUpdatePlugin } from 'rxdb/plugins/update';
import { sha256 } from 'hash-wasm';

addRxPlugin(RxDBUpdatePlugin);

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
}

export class NetworkStore {
  private static instance: NetworkStore;
  private db: RxDatabase<{
    crawls: CrawlsCollection,
    network: NetworkCollection,
    domainStatus: DomainStatusCollection
  }>;
  private readonly MAX_ITEMS = 200;

  private constructor() { }

  public static async getInstance(): Promise<NetworkStore> {
    if (!NetworkStore.instance) {
      NetworkStore.instance = new NetworkStore();
      await NetworkStore.instance.initialize();
    }
    return NetworkStore.instance;
  }

  private async initialize(): Promise<void> {
    this.db = await createDatabase();
  }

  async hashString(str: string): Promise<string> {
    return await sha256(str);
  }

  /**
   * Adds a GET request to the network log with parsed path and query parameters.
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

    // Extract path parameters (e.g., /api/stocks/123 -> ["id"])
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
        // console.log("Updated log with response:", updatedEntry);
        await entry.update({ $set: updatedEntry });
      }
    } catch (error) {
      console.error('Error updating network log with response:', error);
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
}

export default NetworkStore.getInstance();