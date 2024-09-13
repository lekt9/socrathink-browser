// @network.ts

import { ipcMain } from 'electron';

interface NetworkLogEntry {
  id: string;
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
  timestamp: number;
}

let networkLogs: NetworkLogEntry[] = [];

export function addNetworkLog(log: NetworkLogEntry) {
  networkLogs.unshift(log);
  // Limit the number of logs stored to prevent memory issues
  if (networkLogs.length > 1000) networkLogs = networkLogs.slice(0, 1000);
}

export function getNetworkLogs() {
  return networkLogs;
}

export function clearNetworkLogs() {
  networkLogs = [];
}

export function setupNetworkHandlers() {
  ipcMain.handle('get-network-logs', async () => {
    return getNetworkLogs();
  });

  ipcMain.handle('clear-network-logs', async () => {
    clearNetworkLogs();
    return true;
  });
}

export function sendNetworkLogToRenderers(webContents: Electron.WebContents[], channel: string, logEntry: NetworkLogEntry) {
  webContents.forEach((contents) => {
    contents.send(channel, logEntry);
  });
}