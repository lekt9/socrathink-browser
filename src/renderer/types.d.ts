// Define the QueueItem interface for the renderer
export interface QueueItem {
    url: string;
    depth: number;
    timestamp: number;
    score?: number;
}

// Extend the Window interface to include focus functionalities
declare global {
    interface Window {
        // ... existing declarations ...
        focus: {
            setFocus: (mode: 'keyword' | 'semantic', query: string) => Promise<string>;
            clearFocus: () => Promise<string>;
        };
    }
}