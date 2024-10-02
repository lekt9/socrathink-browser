import * as Datastore from '@seald-io/nedb';
import { getPath } from '~/utils';
import { sha256 } from 'hash-wasm';
import { EndpointCollector, generateToolDefinitions, StorableTool } from './tools';

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
  private readonly MAX_ITEMS = 2000;

  private constructor() {
    this.db = new Datastore({
      filename: getPath('storage/actions.db'),
      autoload: true,
    });
  }

  public static async getInstance(): Promise<NetworkStore> {
    if (!NetworkStore.instance) {
      NetworkStore.instance = new NetworkStore();
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
      const updatedEntry = {
        responseStatus: details.status,
        responseHeaders: details.headers,
        responseBody: rawBody,
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
                responsePayload: pair.responseBody.slice(0, 30000),
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

    const insertPromises = tools.flatMap(tool =>
      tool.endpoints.map(async endpoint => {
        const crawlEntry = {
          urlHash: await this.hashString(endpoint.url),
          url: endpoint.requestPayload ? endpoint.url + "\n" + JSON.stringify(endpoint.requestPayload) : endpoint.url,
          contentHash: await this.hashString(endpoint.responsePayload),
          content: JSON.stringify({ url: endpoint.url, request: endpoint.requestPayload, response: endpoint.responsePayload }),
          depth: null,
          timestamp: endpoint.timestamp,
        };

        return new Promise((resolve, reject) => {
          this.db.update({ urlHash: crawlEntry.urlHash }, crawlEntry, { upsert: true }, (err: { message: any; }) => {
            if (err) {
              console.error(`Failed to insert crawl for URL: ${endpoint.url}`, err);
              resolve({ success: false, url: endpoint.url, error: err.message });
            } else {
              resolve({ success: true, url: endpoint.url });
            }
          });
        });
      })
    );

    const results = await Promise.all(insertPromises);

    const successfulInserts = results.filter(result => result.success);
    const failedInserts = results.filter(result => !result.success);

    console.log({
      totalProcessed: results.length,
      successfulInserts: successfulInserts.length,
      failedInserts: failedInserts.length,
      failedUrls: failedInserts.map(result => result.url)
    });

    return tools;
  }
}