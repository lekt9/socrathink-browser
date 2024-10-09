import { getTextExtractor } from 'office-text-extractor';
import { parseMarkdown } from '~/utils/parse';
import fetch from "cross-fetch"
import { BrowserWindow, ipcMain, session } from 'electron';
import { URL } from 'url';
import { AuthFetchOptions } from '~/main/services/context';
import { handleContextOmnidoraRequest } from '~/main';
import cheerio from 'cheerio';

export async function extractDateFromMeta(content: string): Promise<string | null> {
    try {
        const $ = cheerio.load(content);

        // Common meta tag properties
        const metaProperties = [
            'article:published_time',
            'pubdate',
            'publishdate',
            'timestamp',
            'dc.date.issued'
        ];

        for (const property of metaProperties) {
            const metaTag = $(`meta[property="${property}"], meta[name="${property}"]`);
            if (metaTag.length) {
                const content = metaTag.attr('content');
                if (content) {
                    return new Date(content).toISOString();
                }
            }
        }

        return null;
    } catch (error) {
        console.error('Error extracting date from meta tags:', error);
        return null;
    }
}

export const extractLinks = (content: string, baseUrl: string): string[] => {
    const $ = cheerio.load(content);
    const links: string[] = [];

    $('a[href]').each((_, element) => {
        const href = $(element).attr('href');
        if (href) {
            const link = new URL(href, baseUrl).href;
            if (link.startsWith('http')) {
                links.push(link);
            }
        }
    });

    return links;
};

// Helper function to extract links from JSON
function extractLinksFromJson(json: any, baseUrl: string): string[] {
    const links: string[] = [];
    const baseUrlObj = new URL(baseUrl);

    function traverse(obj: any, currentPath: string[] = []) {
        if (Array.isArray(obj)) {
            obj.forEach((item, index) => traverse(item, [...currentPath, index.toString()]));
        } else if (typeof obj === 'object' && obj !== null) {
            Object.entries(obj).forEach(([key, value]) => traverse(value, [...currentPath, key]));
        } else if (typeof obj === 'string' && obj.startsWith('http')) {
            links.push(obj);
        } else if (typeof obj === 'string' || typeof obj === 'number') {
            // Construct potential link based on current path
            const potentialLink = new URL(baseUrlObj.pathname + '/' + currentPath.join('/') + '/' + obj, baseUrlObj.origin);
            links.push(potentialLink.href);
        }
    }

    traverse(json);
    return [...new Set(links)]; // Remove duplicates
}

const TIMEOUT = 1000; // 1 second timeout

export async function simpleFetch(url: string, options = {}): Promise<any> {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

        const response = await fetch(url, { ...options, signal: controller.signal });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentType = response.headers.get('content-type');
        const extractor = getTextExtractor();
        let title: string | null = null;

        if (contentType) {
            if (
                contentType.includes('application/pdf') ||
                contentType.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
                contentType.includes('application/vnd.openxmlformats-officedocument.presentationml.presentation') ||
                contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            ) {
                console.log(`Processing ${contentType}`);
                const buffer = await response.arrayBuffer();
                const text = await extractor.extractText({ input: Buffer.from(buffer), type: 'buffer' });
                return { links: [], content: text, lastModified: null, title: null };
            } else if (contentType.includes('application/json')) {
                console.log("Processing JSON");
                const text = await response.text();
                if (text.length > 500) {
                    try {
                        const jsonContent = JSON.parse(text);
                        const links = extractLinksFromJson(jsonContent, url);
                        return { links, content: JSON.stringify(jsonContent, null, 2), lastModified: null, title: null };
                    } catch (error) {
                        console.error("Error parsing JSON:", error);
                    }
                }
                console.log(`Unsupported content length: ${text.length}`);
                return { links: [], content: '', lastModified: null, title: null };
            } else if (contentType.includes('text/html') || contentType.includes('text/plain')) {
                const content = await response.text();
                const lastModified = await extractDateFromMeta(content);
                const lastModifiedDate = lastModified ? new Date(lastModified).toISOString() : null;

                // Extract title from HTML content
                if (contentType.includes('text/html')) {
                    const $ = cheerio.load(content);
                    title = $('title').text().trim() || null;
                }

                return { links: extractLinks(content, url), content: parseMarkdown(content), lastModified: lastModifiedDate, title };
            } else {
                console.log(`Unsupported content type: ${contentType}`);
                return { links: [], content: '', lastModified: null, title: null };
            }
        } else {
            console.log("No content type specified");
            return { links: [], content: '', lastModified: null, title: null };
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('Request timed out');
        } else {
            console.error('Error in simpleFetch:', error);
        }
        return { links: [], content: '', lastModified: null, title: null };
    }
}

export async function parsePdf(pdfBuffer: ArrayBuffer): Promise<string> {
    try {
        const extractor = getTextExtractor();
        const text = await extractor.extractText({ input: Buffer.from(pdfBuffer), type: 'buffer' });
        return text;
    } catch (error) {
        console.error('Error parsing PDF:', error);
        throw error;
    }
}

export async function hybridFetch(url: string, options: AuthFetchOptions = {}): Promise<any> {
    try {
        const { content: simpleContent, links, lastModified, title } = await simpleFetch(url, options);
        return { content: simpleContent, links, lastModified, title };
    } catch (error) {
        console.error('Error in hybridFetch:', error);
        return { content: '', links: [], lastModified: null, title: null };
    }
}