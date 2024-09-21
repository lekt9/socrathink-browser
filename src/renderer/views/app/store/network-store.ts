import { CrawlsCollection, createDatabase, DomainStatusCollection, NetworkCollection, EmbeddingsCollection } from './rxdb-setup';
import { addRxPlugin, RxDatabase } from 'rxdb';
import { RxDBUpdatePlugin } from 'rxdb/plugins/update';
import { sha256 } from 'hash-wasm';
import { EmbeddingDocument } from './rxdb-setup';
addRxPlugin(RxDBUpdatePlugin);

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
  private db!: RxDatabase<{
    crawls: CrawlsCollection;
    network: NetworkCollection;
    domainStatus: DomainStatusCollection;
    embeddings: EmbeddingsCollection;
  }>;
  private sampleVectors: number[][] = [];

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

    // Initialize or load sample vectors
    // For example purposes, we can generate random sample vectors or load from a file
    this.sampleVectors = [
      // Replace with your actual sample vectors
      [/* vector values */],
      [/* vector values */],
      [/* vector values */],
      [/* vector values */],
      [/* vector values */],
    ];
  }

  async hashString(str: string): Promise<string> {
    return sha256(str);
  }

  /**
   * Adds a request to the network log and generates embeddings.
   */
  public async addRequestToLog(details: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    initiator: any;
  }): Promise<StoredNetworkData | null> {
    const urlHash = await this.hashString(details.url);
    const urlObj = new URL(details.url);
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? `:${urlObj.port}` : ''}`;
    const path = urlObj.pathname;
    const queryParams: Record<string, string> = {};
    urlObj.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    // Extract path parameters (implement as needed)
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
      responseStatus: 0,
      responseHeaders: {},
      responseBody: undefined,
      contentHash: '',
      timestamp: Date.now(),
      parentUrlHash: details.initiator?.urlHash,
    };

    try {
      // Insert into network collection
      await this.db.network.insert(newEntry);

      // Generate embedding
      const embedding = await this.generateEmbedding(newEntry);

      // Calculate index values
      const indexValues = this.calculateIndexValues(embedding);

      // Create embedding document
      const embeddingDoc: EmbeddingDocument = {
        id: newEntry.requestId,
        baseUrl: newEntry.baseUrl,
        path: newEntry.path,
        embedding,
        idx0: indexNrToString(indexValues[0]),
        idx1: indexNrToString(indexValues[1]),
        idx2: indexNrToString(indexValues[2]),
        idx3: indexNrToString(indexValues[3]),
        idx4: indexNrToString(indexValues[4]),
      };

      // Insert into embeddings collection
      await this.db.embeddings.insert(embeddingDoc);

      return newEntry;
    } catch (error) {
      console.error('Error adding request to log:', error);
      return null;
    }
  }

  /**
   * Generates an embedding for the given network entry.
   */
  private async generateEmbedding(entry: StoredNetworkData): Promise<number[]> {
    const textToEmbed = `${entry.baseUrl} ${entry.path} ${entry.requestBody || ''} ${entry.responseBody || ''}`;
    return await this.getEmbeddingFromText(textToEmbed);
  }

  /**
   * Generates embedding from text using the pipeline.
   */
  private async getEmbeddingFromText(text: string): Promise<number[]> {
    return Array.from(await window.embed.run(text));
  }

  /**
   * Calculates index values based on distance to sample vectors.
   */
  private calculateIndexValues(embedding: number[]): number[] {
    const distances: number[] = [];
    for (let i = 0; i < this.sampleVectors.length; i++) {
      const distance = euclideanDistance(this.sampleVectors[i], embedding);
      distances.push(distance);
    }
    return distances;
  }

  /**
   * Extracts path parameters from a URL path.
   * Modify this method based on your API structure.
   */
  private extractPathParams(path: string): string[] | undefined {
    // Implement your logic to extract path parameters
    return undefined;
  }

  // Implement other methods as needed, such as search functions, update logic, etc.
}

export default NetworkStore.getInstance();