import { expose } from 'threads/worker';
import { URL } from 'url';
import fetch from 'node-fetch';
import { SerializableAuthInfo } from './context';
import { parseMarkdown } from '~/utils/parse';
import { PDFDocument } from 'pdf-lib';
import { getTextExtractor } from 'office-text-extractor';

const TIMEOUT = 500; // 0.5 seconds timeout

const extractLinks = (content: string, baseUrl: string): string[] => {
    const linkRegex = /<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>/g;
    const links: string[] = [];
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
        const link = new URL(match[1], baseUrl).href;
        if (link.startsWith('http')) {
            links.push(link);
        }
    }
    return links;
};
async function parseDoc(pdfBuffer: ArrayBuffer): Promise<string> {
    const extractor = getTextExtractor();
    try {
        const text = await extractor.extractText({ input: Buffer.from(pdfBuffer), type: 'buffer' });
        return text;
    } catch (error) {
        console.error('Error parsing PDF:', error);
        throw error;
    }
}


async function simpleFetch(url: string, options = {}): Promise<any> {
    try {
        const response = await fetch(url, options);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');

        if (contentType.includes('application/pdf') ||
            contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
            contentType.includes('application/vnd.openxmlformats-officedocument.presentationml.presentation') ||
            contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
            console.log("Processing PDF URL");
            const pdfBuffer = await response.arrayBuffer();
            const pdfText = await parseDoc(pdfBuffer);
            return { links: [], rawHtml: pdfText, content: parseMarkdown(pdfText) };
        } else {
            const content = await response.text();
            return { links: extractLinks(content, url), rawHtml: content, content: parseMarkdown(content) };
        }
    } catch (error) {
        console.error('Error in simpleFetch:', error);
        return { links: [], content: '' };
    }
}
// Update the crawlUrl function
const crawlUrl = async (authInfo: SerializableAuthInfo, depth: number) => {
    try {
        const { url, headers } = authInfo;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

        const { rawHtml, content, links } = await simpleFetch(url, {
            method: 'GET',
            headers: headers,
        });
        // console.log({ links })
        clearTimeout(timeoutId);

        if (content && content.trim().length === 0) {
            // console.log(`No useful content found for URL: ${url}`);
            return { url, rawHtml: '', content: '', links: [], completed: false };
        } else {
            return {
                url: authInfo.url,
                rawHtml,
                content,
                links: links ?? [],
                completed: true,
                depth
            };
        }
    } catch (error) {
        console.error(`Crawl error: ${error.message}`);
        return { url: authInfo.url, rawHtml: '', content: '', links: [], completed: false };
    }
};


const depth = 0
const CrawlerWorker = {
    crawlUrl,
    depth,
};
expose(CrawlerWorker);

export type CrawlerWorker = typeof CrawlerWorker;