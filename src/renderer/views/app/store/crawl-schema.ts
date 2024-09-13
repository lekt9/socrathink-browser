export const crawlSchema = {
    title: 'crawl schema',
    description: 'describes a crawl data',
    version: 0,
    primaryKey: 'url',
    type: 'object',
    properties: {
        url: {
            type: 'string',
            maxLength: 100,
        },
        content: {
            type: 'string',
        },
        hash: {
            type: 'string',
        },
        timestamp: {
            type: 'number',
        },
        json: {
            type: 'object',
            properties: {},
            additionalProperties: true,
        },
    },
    required: ['url', 'content', 'hash', 'timestamp'],
};