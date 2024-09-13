// @network-store.ts

import { makeObservable, observable, action } from 'mobx';
import { ipcRenderer } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sha256 } from 'hash-wasm';

export interface StoredNetworkData {
  url: string;
  request: {
    method: string;
    // headers?: Record<string, string>;
    body?: string;
  };
  response: {
    status: number;
    // headers?: Record<string, string>;
    body?: string;
  };
  hash: string;
  timestamp: number;
}

export class NetworkStore {
  @observable
  private store: Map<string, StoredNetworkData> = new Map();

  // @observable
  // public headers: Record<string, string[]> = {};

  private filePath: string;
  // private vectorStore: VectorStore;

  constructor() {
    makeObservable(this);
    this.filePath = path.join(os.homedir(), 'network-store.json');
    // this.vectorStore = new VectorStore();
    this.initializeListeners();
    this.load();
  }

  private initializeListeners() {
    ipcRenderer.on('network-request-started', (_, requestDetails) => {
      this.addRequestToLog(requestDetails);
    });

    ipcRenderer.on('network-response-received', (_, responseDetails) => {
      this.updateLogWithResponse(responseDetails);
    });
  }

  @action
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsedData = JSON.parse(data);
        this.store = new Map(Object.entries(parsedData));
        // this.loadHeaders();
      }
    } catch (error) {
      console.error('Error loading network store:', error);
    }
  }

  @action
  private save(): void {
    try {
      const data = JSON.stringify(Object.fromEntries(this.store));
      fs.writeFileSync(this.filePath, data, 'utf-8');
    } catch (error) {
      console.error('Error saving network store:', error);
    }
  }

  // @action
  // private loadHeaders() {
  //   this.store.forEach(entry => {
  //     this.addHeaders(entry.request.headers);
  //     this.addHeaders(entry.response.headers);
  //   });
  // }

  @action
  public async clearLogs() {
    this.store.clear();
    // this.headers = {};
    this.save();
  }

  @action
  public async refreshLogs() {
    this.load();
  }

  @action
  private async addRequestToLog(requestDetails: Omit<StoredNetworkData['request'], 'id'> & { id: string, url: string }) {
    const newEntry: StoredNetworkData = {
      url: requestDetails.url,
      request: {
        method: requestDetails.method,
        // headers: requestDetails.headers,
        body: requestDetails.body,
      },
      response: null,
      hash: '',
      timestamp: Date.now(),
    };
    this.store.set(requestDetails.id, newEntry);
    // this.addHeaders(requestDetails.headers);
    this.save();
  }

  @action
  private async updateLogWithResponse(responseDetails: StoredNetworkData['response'] & { id: string }) {
    const entry = this.store.get(responseDetails.id);
    if (entry) {
      entry.response = {
        status: responseDetails.status,
        body: responseDetails.body,
      };
      entry.hash = await this.hashString(JSON.stringify(entry.response));
      this.save();

      // Add to vector store
      // this.vectorStore.addToVectorStore(entry as unknown as StoredCrawlData);
    }
  }

  private async hashString(str: string): Promise<string> {
    return await sha256(str);
  }

  // @action
  // private addHeaders(headers: Record<string, string>) {
  //   if (headers) {
  //     Object.entries(headers).forEach(([key, value]) => {
  //       if (!this.headers[key]) {
  //         this.headers[key] = [];
  //       }
  //       if (!this.headers[key].includes(value)) {
  //         this.headers[key].push(value);
  //       }
  //     });
  //   }
  // }

  // public getUniqueHeaderNames(): string[] {
  //   return Object.keys(this.headers);
  // }

  // public getUniqueHeaderValues(headerName: string): string[] {
  //   return this.headers[headerName] || [];
  // }

  public get(id: string): StoredNetworkData | undefined {
    return this.store.get(id);
  }

  public has(id: string): boolean {
    return this.store.has(id);
  }

  public getAll(): StoredNetworkData[] {
    return Array.from(this.store.values());
  }

  public size(): number {
    return this.store.size;
  }

}

export default new NetworkStore();