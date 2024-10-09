import * as Datastore from '@seald-io/nedb';
import { getPath } from '~/utils';
import { sha256 } from 'hash-wasm';
import { EndpointCollector, generateToolDefinitions, StorableTool } from './tools';
import { CrawlStore } from './crawl-store';
import * as fs from 'fs';
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
  type: string;
}

export class NetworkStore {
  private static instance: NetworkStore;
  private db: Datastore;
  private crawl: CrawlStore;
  private readonly MAX_ITEMS = 200;

  private constructor(crawl: CrawlStore) {
    this.db = new Datastore({
      filename: getPath('storage/network_store.db'),
      autoload: true,
    });
    this.crawl = crawl
  }

  public static async getInstance(crawl: CrawlStore): Promise<NetworkStore> {
    if (!NetworkStore.instance) {
      NetworkStore.instance = new NetworkStore(crawl);
    }
    return NetworkStore.instance;
  }

  async hashString(str: string): Promise<string> {
    return await sha256(str);
  }

  public async addRequestToLog(details: { requestId: string; url: string; method: string; headers: Record<string, string>; body?: string; initiator: any; type: string }): Promise<StoredNetworkData | null> {
    // Only process XHR requests
    if (details.type !== 'XHR' && details.type !== 'Fetch') return null;

    const urlHash = await this.hashString(details.url);
    const urlObj = new URL(details.url);
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? `:${urlObj.port}` : ''}`;
    const path = urlObj.pathname;
    const queryParams: Record<string, string> = {};
    urlObj.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

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
      responseStatus: 0,
      responseHeaders: {},
      responseBody: undefined,
      contentHash: '',
      timestamp: Date.now(),
      parentUrlHash: details.initiator?.urlHash
    };
    const currentCount = await this.size();
    if (currentCount >= this.MAX_ITEMS) {
      await this.removeOldestEntries(1);
    }
    return new Promise((resolve, reject) => {
      this.db.insert(newEntry, (err: any, doc: StoredNetworkData) => {
        if (err) {
          reject(err);
        } else {
          resolve(doc as StoredNetworkData);
        }
      });
    });
  }

  public async updateLogWithResponse(details: { requestId: string; status: number; headers: Record<string, string>; body?: string }): Promise<void> {
    try {
      const rawBody = details.body || '';
      const contentHash = await this.hashString(rawBody);
      let truncatedBody = rawBody;

      if (rawBody.length > 50000) {
        truncatedBody = this.truncateJSON(rawBody, 50000);
      }

      const updatedEntry = {
        responseStatus: details.status,
        responseHeaders: details.headers,
        responseBody: truncatedBody,
        contentHash,
      };

      return new Promise((resolve, reject) => {
        this.db.update({ requestId: details.requestId }, { $set: updatedEntry }, {}, (err: any) => {
          if (err) {
            console.error('Error updating network log with response:', err);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } catch (error) {
      console.error('Error updating network log with response:', error);
      throw error;
    }
  }

  private truncateJSON(jsonString: string, maxLength: number): string {
    try {
      const obj = JSON.parse(jsonString);
      const truncated = this.truncateObject(obj, maxLength);
      return JSON.stringify(truncated);
    } catch (error) {
      // If parsing fails, truncate the string directly
      return jsonString.slice(0, maxLength);
    }
  }

  private truncateObject(obj: any, maxLength: number): any {
    const stringify = (o: any) => JSON.stringify(o);
    const parse = (s: string) => JSON.parse(s);

    if (stringify(obj).length <= maxLength) {
      return obj;
    }

    if (Array.isArray(obj)) {
      let i = obj.length;
      while (i > 0 && stringify(obj.slice(0, i)).length > maxLength) {
        i--;
      }
      return obj.slice(0, i);
    }

    if (typeof obj === 'object' && obj !== null) {
      const newObj: any = {};
      for (const key of Object.keys(obj)) {
        const tempObj = { ...newObj, [key]: obj[key] };
        if (stringify(tempObj).length <= maxLength) {
          newObj[key] = obj[key];
        } else {
          break;
        }
      }
      return newObj;
    }

    return obj;
  }

  public async clearLogs(): Promise<void> {
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

  public async get(requestId: string): Promise<StoredNetworkData | null> {
    return new Promise((resolve, reject) => {
      this.db.findOne({ requestId }, (err: any, doc: StoredNetworkData) => {
        if (err) {
          reject(err);
        } else {
          resolve(doc as StoredNetworkData | null);
        }
      });
    });
  }

  public async has(requestId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.findOne({ requestId }, (err: any, doc: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(!!doc);
        }
      });
    });
  }

  public async getAll(): Promise<StoredNetworkData[]> {
    return new Promise((resolve, reject) => {
      this.db.find({}, (err: any, docs: StoredNetworkData[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(docs as StoredNetworkData[]);
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
          resolve(count);
        }
      });
    });
  }

  private extractPathParams(path: string): string[] | undefined {
    const segments = path.split('/').filter(Boolean);
    const params: string[] = [];

    segments.forEach((segment, index) => {
      if (this.isDynamicSegment(segment)) {
        params.push(`param${index}`);
      }
    });

    return params.length > 0 ? params : undefined;
  }

  private isDynamicSegment(segment: string): boolean {
    const uuidRegex = /^[0-9a-fA-F-]{36}$/;
    const numberRegex = /^\d+$/;
    return uuidRegex.test(segment) || numberRegex.test(segment);
  }

  public async deriveTools() {
    return new Promise<StorableTool[]>((resolve, reject) => {
      this.db.find({ responseStatus: { $gte: 200, $lt: 300 }, responseBody: { $exists: true } }, (err: any, pairs: any) => {
        if (err) {
          reject(err);
        } else {
          const collector = new EndpointCollector();
          console.log('Processing', pairs.length, 'pairs');

          for (const pair of pairs) {
            try {
              collector.processEndpoint({
                url: pair.url,
                requestPayload: pair.requestBody,
                responsePayload: pair.responseBody,
                timestamp: pair.timestamp
              });
              console.log(`Processed endpoint: ${pair.url}`);
            } catch (error) {
              console.log(`Error processing endpoint: ${pair.url}`, error);
            }
          }

          const tools = collector.getTools().filter(tool => tool.endpoints.length > 1);
          console.log(`Found ${tools.length} tools`);
          resolve(tools);
        }
      });
    });
  }

  private async removeOldestEntries(count: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.find({})
        .sort({ timestamp: 1 })
        .limit(count)
        .exec((err: any, oldestEntries: any[]) => {
          if (err) {
            reject(err);
          } else {
            const oldestIds = oldestEntries.map((entry: { _id: any; }) => entry._id);
            this.db.remove({ _id: { $in: oldestIds } }, { multi: true }, (removeErr: any, numRemoved: any) => {
              if (removeErr) {
                reject(removeErr);
              } else {
                console.log(`Removed ${numRemoved} oldest entries from the database.`);
                resolve();
              }
            });
          }
        });
    });
  }

  public async getTools() {
    const tools = await this.deriveTools();
    const requestResponsePairs = [];

    for (const tool of tools) {
      for (const endpoint of tool.endpoints) {
        try {
          const urlObj = new URL(endpoint.url);
          const pair = {
            method: endpoint.method,
            url: endpoint.url,
            query_params: Object.fromEntries(urlObj.searchParams),
            request_payload: endpoint.requestPayload && endpoint.requestPayload.includes('{') ? JSON.parse(endpoint.requestPayload) : null,
            response: endpoint.responsePayload && endpoint.responsePayload.includes('{') ? JSON.parse(endpoint.responsePayload) : null
          };
          requestResponsePairs.push(pair);
        } catch (error) {
          console.log(`Error processing endpoint: ${endpoint.url}`, error);
        }
      }
    }

    // Save the request-response pairs to a JSON file
    const outputPath = './request_response_pairs.json';
    fs.writeFileSync(outputPath, JSON.stringify(requestResponsePairs, null, 2));

    console.log(`Saved ${requestResponsePairs.length} request-response pairs to ${outputPath}`);

    return tools;
  }
}