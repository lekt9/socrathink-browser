// File: src/preload.ts

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    loadUrl: (url: string) => ipcRenderer.invoke('load-url', url)
});