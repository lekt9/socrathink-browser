export interface RequestResponsePair {
    url: string;
    requestPayload: any;
    responsePayload: any;
}
export interface StorableTool {
    name: string;
    pattern: string;
    endpoints: ProcessedEndpointInfo[];
    queryParamOptions: { [key: string]: string[] };
}
export interface PathInfo {
    path: string; // Generalized path
    queryParams: {
        [key: string]: 'enum' | 'dynamic';
    };
}

export interface ProcessedEndpointInfo {
    url: string;
    requestPayload: any;
    responsePayload: any;
    pathInfo: PathInfo;
    schemaSignature: string;
}

export class Tool implements StorableTool {
    name: string;
    pattern: string;
    endpoints: ProcessedEndpointInfo[] = [];
    private _queryParamOptions: { [key: string]: Set<string> } = {};
    schemaSignature: string;

    constructor(name: string, pattern: string, schemaSignature: string) {
        this.name = name;
        this.pattern = pattern;
        this.schemaSignature = schemaSignature;
    }

    addEndpoint(endpoint: ProcessedEndpointInfo) {
        this.endpoints.push(endpoint);
        this.updateQueryParamOptions(endpoint);
    }

    private updateQueryParamOptions(endpoint: ProcessedEndpointInfo) {
        const url = new URL(endpoint.url);
        for (const [key, value] of url.searchParams.entries()) {
            if (!this._queryParamOptions[key]) {
                this._queryParamOptions[key] = new Set();
            }
            this._queryParamOptions[key].add(value);
        }
    }
    get queryParamOptions(): { [key: string]: string[] } {
        const result: { [key: string]: string[] } = {};
        for (const [key, valueSet] of Object.entries(this._queryParamOptions)) {
            result[key] = Array.from(valueSet);
        }
        return result;
    }

    getQueryParamPermutations(): { [key: string]: string[] } {
        const permutations: { [key: string]: string[] } = {};
        for (const [key, values] of Object.entries(this.queryParamOptions)) {
            permutations[key] = Array.from(values);
        }
        return permutations;
    }
}

export class EndpointCollector {
    private endpoints: ProcessedEndpointInfo[] = [];
    private tools: Tool[] = [];

    processEndpoint(pair: RequestResponsePair) {
        if (this.endpoints.find(ep => ep.url === pair.url)) {
            return; // Skip if we've already processed this exact URL
        }

        const pathInfo = this.extractPathInfo(pair.url, pair.responsePayload);
        const schemaSignature = this.generateSchemaSignature(pair.requestPayload, pair.responsePayload);

        const processedInfo: ProcessedEndpointInfo = {
            ...pair,
            pathInfo,
            schemaSignature
        };

        this.endpoints.push(processedInfo);
        this.assignToTool(processedInfo);
    }

    private extractPathInfo(url: string, response: any): PathInfo {
        const parsedUrl = new URL(url);
        const queryParams = this.determineQueryParams(parsedUrl.searchParams);

        const generalizedPath = this.generalizePath(parsedUrl.pathname, response);

        return {
            path: generalizedPath,
            queryParams
        };
    }

    private determineQueryParams(
        searchParams: URLSearchParams
    ): { [key: string]: 'enum' | 'dynamic' } {
        const queryParams: { [key: string]: 'enum' | 'dynamic' } = {};
        for (const [key, value] of searchParams.entries()) {
            queryParams[key] = this.determineQueryParamType(value);
        }
        return queryParams;
    }

    private determineQueryParamType(value: string): 'enum' | 'dynamic' {
        // Define threshold for dynamic parameters
        return value.length > 5 ? 'dynamic' : 'enum';
    }

    private generalizePath(path: string, response: any): string {
        const segments = path.split('/').filter(seg => seg.length > 0);
        const operations = Object.keys(response).map(key => key.toLowerCase());

        return '/' + segments.map((segment, index) => {
            if (operations.includes(segment.toLowerCase())) {
                return segment;
            } else if (index === 0) {
                // Assume the first segment is a resource and keep it
                return segment;
            } else {
                return `:param${index}`;
            }
        }).join('/');
    }

    private generateSchemaSignature(request: any, response: any): string {
        const requestSchema = this.jsonToSchema(request);
        const responseSchema = this.jsonToSchema(response);
        return JSON.stringify({ requestSchema, responseSchema });
    }

    private jsonToSchema(obj: any): any {
        if (obj === null) {
            return { type: 'null' };
        }

        const type = typeof obj;

        if (type === 'number') {
            return { type: 'number' };
        }

        if (type === 'string') {
            return { type: 'string' };
        }

        if (type === 'boolean') {
            return { type: 'boolean' };
        }

        if (Array.isArray(obj)) {
            if (obj.length === 0) {
                return { type: 'array', items: {} };
            }
            // Assume all items in the array are of the same type
            const itemSchemas = obj.map(item => this.jsonToSchema(item));
            const uniqueItemSchemas = this.mergeSchemas(itemSchemas);
            return { type: 'array', items: uniqueItemSchemas };
        }

        if (type === 'object') {
            const properties: { [key: string]: any } = {};
            const required: string[] = [];

            for (const key of Object.keys(obj)) {
                properties[key] = this.jsonToSchema(obj[key]);
                required.push(key);
            }

            return {
                type: 'object',
                properties,
                required
            };
        }

        // Fallback for undefined or unknown types
        return {};
    }

    private mergeSchemas(schemas: any[]): any {
        if (schemas.length === 0) {
            return {};
        }

        if (schemas.length === 1) {
            return schemas[0];
        }

        const types = new Set<string>();
        const mergedProperties: { [key: string]: any } = {};
        let mergedRequired: string[] = [];

        schemas.forEach(schema => {
            if (schema.type) {
                types.add(schema.type);
            }

            if (schema.type === 'object' && schema.properties) {
                for (const [key, value] of Object.entries(schema.properties)) {
                    if (!mergedProperties[key]) {
                        mergedProperties[key] = value;
                        if (schema.required && schema.required.includes(key)) {
                            mergedRequired.push(key);
                        }
                    } else {
                        mergedProperties[key] = this.mergeSchemas([mergedProperties[key], value]);
                    }
                }
            }
        });

        const mergedSchema: any = {};

        if (types.size === 1) {
            mergedSchema.type = Array.from(types)[0];
        } else {
            mergedSchema.type = Array.from(types);
        }

        if (Object.keys(mergedProperties).length > 0) {
            mergedSchema.properties = mergedProperties;
            mergedSchema.required = Array.from(new Set(mergedRequired));
        }

        return mergedSchema;
    }

    private assignToTool(endpoint: ProcessedEndpointInfo) {
        // Check if a tool with the same path and schema signature exists
        const existingTool = this.tools.find(
            tool =>
                tool.pattern === endpoint.pathInfo.path &&
                tool.schemaSignature === endpoint.schemaSignature
        );

        if (existingTool) {
            existingTool.addEndpoint(endpoint);
        } else {
            // Create a new tool
            const toolName = this.extractToolName(endpoint.pathInfo.path);
            const newTool = new Tool(toolName, endpoint.pathInfo.path, endpoint.schemaSignature);
            newTool.addEndpoint(endpoint);
            this.tools.push(newTool);
        }
    }

    private extractToolName(pattern: string): string {
        // Extract the first segment as the tool name
        const segments = pattern.split('/');
        return segments.length > 1 ? segments[1] : 'unknown';
    }

    getTools(): Tool[] {
        return this.tools;
    }

    finalize() {
        // Any final processing if needed
    }
}

// Example RequestResponsePairs
const examplePairs: RequestResponsePair[] = [
    {
        url: 'https://api.example.com/stocks/IBM/price?currency=USD',
        requestPayload: { method: 'GET' },
        responsePayload: { price: 135.67, currency: 'USD' }
    },
    {
        url: 'https://api.example.com/stocks/AAPL/history?from=2023-01-01&to=2023-12-31',
        requestPayload: { method: 'GET' },
        responsePayload: { history: [/* ... */], from: '2023-01-01', to: '2023-12-31' }
    },
    {
        url: 'https://api.example.com/stocks/GOOGL/earnings?quarter=Q1',
        requestPayload: { method: 'GET' },
        responsePayload: { earnings: '15B', quarter: 'Q1' }
    },
    {
        url: 'https://api.example.com/stocks/MSFT/dividends?year=2023',
        requestPayload: { method: 'GET' },
        responsePayload: { dividends: 2.50, year: 2023 }
    },
    {
        url: 'https://api.example.com/stocks/TSLA/news?limit=5',
        requestPayload: { method: 'GET' },
        responsePayload: { news: [/* ... */], limit: 5 }
    },
    {
        url: 'https://api.example.com/stocks/AAPL/price?currency=EUR',
        requestPayload: { method: 'GET' },
        responsePayload: { price: 125.50, currency: 'EUR' }
    },
    {
        url: 'https://api.example.com/forex/USD/EUR?amount=1000',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'USD', to: 'EUR', amount: 1000, converted: 846.72 }
    },
    {
        url: 'https://api.example.com/forex/JPY/USD?amount=100000',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'JPY', to: 'USD', amount: 100000, converted: 925.93 }
    },
    {
        url: 'https://api.example.com/forex/EUR/GBP?amount=500',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'EUR', to: 'GBP', amount: 500, converted: 432.10 }
    },
    {
        url: 'https://api.example.com/forex/AUD/CAD?amount=750',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'AUD', to: 'CAD', amount: 750, converted: 700.50 }
    },
    {
        url: 'https://api.example.com/forex/GBP/USD?amount=2000',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'GBP', to: 'USD', amount: 2000, converted: 2760.00 }
    },
    {
        url: 'https://api.example.com/forex/CAD/JPY?amount=1500',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'CAD', to: 'JPY', amount: 1500, converted: 163500.00 }
    },
    {
        url: 'https://api.example.com/forex/USD/CHF?amount=3000',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'USD', to: 'CHF', amount: 3000, converted: 2750.25 }
    },
    {
        url: 'https://api.example.com/forex/GBP/EUR?amount=2500',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'GBP', to: 'EUR', amount: 2500, converted: 2700.75 }
    },
    {
        url: 'https://api.example.com/forex/EUR/JPY?amount=4000',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'EUR', to: 'JPY', amount: 4000, converted: 522000.00 }
    },
    {
        url: 'https://api.example.com/forex/AUD/USD?amount=5000',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'AUD', to: 'USD', amount: 5000, converted: 3700.00 }
    },
    {
        url: 'https://api.example.com/forex/CHF/USD?amount=3500',
        requestPayload: { method: 'GET' },
        responsePayload: { from: 'CHF', to: 'USD', amount: 3500, converted: 3800.50 }
    },
    // Additional endpoints can be added here...
];

function main() {
    const collector = new EndpointCollector();

    for (const pair of examplePairs) {
        try {
            collector.processEndpoint(pair);
        } catch (error) {
            console.log(`Error processing endpoint: ${pair.url}`, error);
        }
    }


    const tools = collector.getTools();
    console.log("Collected Tools:");
    for (const tool of tools) {
        console.log(`\nTool: ${tool.name} (${tool.pattern})`);
        console.log("Endpoints:");
        for (const endpoint of tool.endpoints) {
            console.log(`  ${endpoint.url}`);
        }
        console.log("Query param permutations:");
        console.log(JSON.stringify(tool.getQueryParamPermutations(), null, 2));
    }
}

// main();