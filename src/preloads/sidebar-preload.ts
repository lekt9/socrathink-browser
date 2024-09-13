import { ipcRenderer } from 'electron';
import { contextBridge } from 'electron';
declare global {
  interface Window {
    authedFetch: (url: string, options?: any) => Promise<any>;
    fetchContext: (url: string) => Promise<any>;
    loadURL: (url: string) => Promise<any>;
  }
}

window.authedFetch = async (url: string, options = {}) => {
  return ipcRenderer.invoke('authed-fetch', { url, options });
};

window.fetchContext = async (url: string) => {
  return ipcRenderer.invoke('fetch-context', url);
};

window.loadURL = async (url: string, text?: string) => {
  return ipcRenderer.invoke('open-url', url, text);
};

contextBridge.exposeInMainWorld('authedFetch', async (url: string, options = {}) => {
  return ipcRenderer.invoke('authed-fetch', url, options);
});

contextBridge.exposeInMainWorld('fetchContext', async (url: string) => {
  return ipcRenderer.invoke('fetch-context', url);
});

contextBridge.exposeInMainWorld('loadURL', async (url: string, text?: string) => {
  return ipcRenderer.invoke('open-url', url, text);
});