import { expose } from 'threads/worker';
import { URL } from 'url';
import fetch from 'node-fetch';
import { SerializableAuthInfo } from './context';
import { parseMarkdown } from '~/utils/parse';
import { PDFDocument } from 'pdf-lib';

const TIMEOUT = 10000; // 10 seconds timeout

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
async function parsePdf(pdfBuffer: ArrayBuffer): Promise<string> {
    try {
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const pages = pdfDoc.getPages();
        let text = '';
        for (const page of pages) {
            text += await page.getText();
        }
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

        if (contentType && contentType.includes('application/pdf')) {
            console.log("Processing PDF URL");
            const pdfBuffer = await response.arrayBuffer();
            const pdfText = await parsePdf(pdfBuffer);
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
        console.log({ links })
        clearTimeout(timeoutId);

        if (content && content.trim().length === 0) {
            console.log(`No useful content found for URL: ${url}`);
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