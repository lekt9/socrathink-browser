import { createSchema } from 'genson-js';

export interface RequestResponsePair {
    url: string;
    requestPayload: any;
    responsePayload: any;
    timestamp: number;
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
    timestamp: number;
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
            schemaSignature,
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
        try {
            return createSchema(obj);
        } catch (error) {
            console.log(`Error creating schema for: ${obj}`, error);
            return {};
        }
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


/**
 * Tool Generator Function
 */
export function generateToolDefinitions(tools: Tool[]) {
    const toolDefinitions: { [key: string]: any } = {};

    for (const toolItem of tools) {
        const { name, pattern, endpoints, queryParamOptions } = toolItem;

        // Extract path parameters from the pattern
        const pathParams: string[] = [];
        const pathParts = pattern.split('/').filter(Boolean);
        for (const part of pathParts) {
            if (part.startsWith(':')) {
                pathParams.push(part.substring(1));
            }
        }

        // Build JSON Schema for parameters
        const parameters: any = {
            type: 'object',
            properties: {},
            required: [],
        };

        // Add path parameters
        for (const paramName of pathParams) {
            parameters.properties[paramName] = {
                type: 'string',
                description: `The ${paramName} parameter. Examples: ${getPathParamExamples(
                    endpoints,
                    paramName
                ).join(', ')}.`,
            };
            parameters.required.push(paramName);
        }

        // Add query parameters
        for (const [key, values] of Object.entries(queryParamOptions)) {
            if (values.length <= 5) {
                // Use enum
                parameters.properties[key] = {
                    type: 'string',
                    enum: values,
                    description: `Possible values for ${key}.`,
                };
            } else {
                // Provide examples
                parameters.properties[key] = {
                    type: 'string',
                    description: `The ${key} parameter. Examples: ${values
                        .slice(0, 3)
                        .join(', ')}${values.length > 3 ? ', etc.' : ''}.`,
                };
            }
            parameters.required.push(key);
        }

        // Generate the tool definition with URL reconstruction in execute
        toolDefinitions[name] = {
            description: `Tool for handling ${name.replace(/_/g, ' ')} operation.`,
            parameters: parameters,
        };
    }

    return toolDefinitions;
}

/**
 * Helper Functions
 */

// Extract examples for path parameters
function getPathParamExamples(
    endpoints: ProcessedEndpointInfo[],
    paramName: string
): string[] {
    const examples = new Set<string>();
    for (const endpoint of endpoints) {
        const parsedUrl = new URL(endpoint.url);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        const patternSegments = endpoint.pathInfo.path.split('/').filter(Boolean);
        for (let i = 0; i < patternSegments.length; i++) {
            if (patternSegments[i] === `:${paramName}` && pathSegments[i]) {
                examples.add(pathSegments[i]);
            }
        }
    }
    return Array.from(examples).slice(0, 5); // Return up to 5 examples
}

// Reconstruct the URL from pattern and params
function reconstructUrl(pattern: string, params: any): string {
    const baseUrl = 'https://api.example.com';

    let urlPath = pattern;

    // Replace path parameters
    for (const [key, value] of Object.entries(params)) {
        urlPath = urlPath.replace(`:${key}`, encodeURIComponent(String(value)));
    }

    // Extract query parameters (those not in path params)
    const queryParams: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(params)) {
        if (!pattern.includes(`:${key}`)) {
            queryParams[key] = String(value);
        }
    }

    // Construct query string
    const queryString = Object.keys(queryParams)
        .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key])}`)
        .join('&');

    const fullUrl = queryString ? `${baseUrl}${urlPath}?${queryString}` : `${baseUrl}${urlPath}`;

    return fullUrl;
}



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