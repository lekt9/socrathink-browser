import { CrawlStore } from '~/renderer/views/app/store/crawl-store';
import { QueueManager } from './queue-manager';
import { ModuleThread, Pool } from 'threads';
import { hybridFetch } from '~/utils/hybrid-fetch';
import { ipcMain } from 'electron';

export class LinkProcessor {
    private queueManager: QueueManager;
    private processedFiles: Set<string> = new Set();

    constructor(pool: Pool<ModuleThread>, crawlStore: CrawlStore) {
        this.queueManager = new QueueManager(crawlStore, pool);
        this.setupDownloadCompletedListener();
    }

    private setupDownloadCompletedListener() {
        ipcMain.on('download-queue', (event, fileName: string) => {
            this.processLocalFile(fileName);
        });
    }

    private async processLocalFile(fileName: string): Promise<void> {
        const url = `https://context.socrathink/downloads/${fileName}`;

        try {
            const { content, links } = await hybridFetch(url);

            if (content) {
                await this.queueManager.enqueue(url, 0);
            }

            for (const link of links) {
                await this.queueManager.enqueue(link, 0);
            }

            this.processedFiles.add(fileName);
        } catch (error) {
            console.error(`Error processing file: ${fileName}`, error);
        }
    }

    public async addInitialUrl(url: string): Promise<void> {
        await this.queueManager.addInitialUrl(url);
    }

    public async terminate() {
        // Implement termination logic if needed
    }
}