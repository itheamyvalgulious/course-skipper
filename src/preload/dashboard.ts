import { contextBridge, ipcRenderer } from 'electron';

export interface SkipperAPI {
  // Input layer & browser operations
  openBrowser: (url?: string) => Promise<void>;
  hideBrowser: () => Promise<void>;
  showBrowser: () => Promise<void>;
  completeInitialization: () => Promise<void>;
  captureSingleFrame: () => Promise<any>;
  setMuteLocal: (muted: boolean) => Promise<boolean>;

  // Config operations
  getConfig: () => Promise<any>;

  // Processing layer operations
  startMonitoring: (prompt?: string) => Promise<void>;
  pauseMonitoring: () => Promise<void>;
  resumeMonitoring: () => Promise<void>;
  stopMonitoring: () => Promise<void>;
  setUserPrompt: (prompt: string) => Promise<void>;
  getStatus: () => Promise<any>;

  // Action layer operations
  testNotification: (reason?: string, summary?: string) => Promise<boolean>;

  // Provider operations
  mockTriggerNotification: (reason?: string, summary?: string) => Promise<void>;
  setApiKey: (apiKey: string) => Promise<boolean>;
  setProviderMode: (useMockServer: boolean, endpoint?: string) => Promise<boolean>;
  setBackendType: (backendType: 'aistudio' | 'vertex' | 'mock') => Promise<boolean>;
  setVertexConfig: (project?: string, location?: string) => Promise<boolean>;
  setProviderConfig: (config: {
    backendType?: 'aistudio' | 'vertex' | 'mock';
    apiKey?: string;
    project?: string;
    location?: string;
    endpoint?: string;
    model?: string;
  }) => Promise<boolean>;
  setModel: (model: string) => Promise<boolean>;

  // Audio capture pipeline
  sendAudioChunk: (buffer: ArrayBuffer, level?: number) => void;

  // Real-time event subscriptions
  onStatusUpdate: (callback: (status: any) => void) => void;
  onFrameProcessed: (callback: (frame: any) => void) => void;
  onAudioLevel: (callback: (level: number) => void) => void;
  onNotification: (callback: (notif: any) => void) => void;
  onUsageMetadata: (callback: (usage: any) => void) => void;
  onProviderStatus: (callback: (status: string) => void) => void;
  onProviderError: (callback: (err: string) => void) => void;
  onUrlChanged: (callback: (url: string) => void) => void;
}

const api: SkipperAPI = {
  openBrowser: (url) => ipcRenderer.invoke('skipper:open-browser', url),
  hideBrowser: () => ipcRenderer.invoke('skipper:hide-browser'),
  showBrowser: () => ipcRenderer.invoke('skipper:show-browser'),
  completeInitialization: () => ipcRenderer.invoke('skipper:complete-init'),
  captureSingleFrame: () => ipcRenderer.invoke('skipper:capture-frame'),
  setMuteLocal: (muted) => ipcRenderer.invoke('skipper:set-mute-local', muted),

  getConfig: () => ipcRenderer.invoke('skipper:get-config'),

  startMonitoring: (prompt) => ipcRenderer.invoke('skipper:start-monitoring', prompt),
  pauseMonitoring: () => ipcRenderer.invoke('skipper:pause-monitoring'),
  resumeMonitoring: () => ipcRenderer.invoke('skipper:resume-monitoring'),
  stopMonitoring: () => ipcRenderer.invoke('skipper:stop-monitoring'),
  setUserPrompt: (prompt) => ipcRenderer.invoke('skipper:set-prompt', prompt),
  getStatus: () => ipcRenderer.invoke('skipper:get-status'),

  testNotification: (reason, summary) => ipcRenderer.invoke('skipper:test-notification', reason, summary),
  mockTriggerNotification: (reason, summary) =>
    ipcRenderer.invoke('skipper:mock-trigger-notification', reason, summary),
  setApiKey: (apiKey) => ipcRenderer.invoke('skipper:set-api-key', apiKey),
  setProviderMode: (useMockServer, endpoint) =>
    ipcRenderer.invoke('skipper:set-provider-mode', useMockServer, endpoint),
  setBackendType: (backendType) => ipcRenderer.invoke('skipper:set-backend-type', backendType),
  setVertexConfig: (project, location) => ipcRenderer.invoke('skipper:set-vertex-config', project, location),
  setProviderConfig: (config) => ipcRenderer.invoke('skipper:set-provider-config', config),
  setModel: (model) => ipcRenderer.invoke('skipper:set-model', model),

  sendAudioChunk: (buffer, level) => {
    ipcRenderer.send('skipper:audio-chunk', Buffer.from(buffer), level);
  },

  onStatusUpdate: (callback) => {
    ipcRenderer.on('skipper:status-update', (_e, status) => callback(status));
  },
  onFrameProcessed: (callback) => {
    ipcRenderer.on('skipper:frame-processed', (_e, frame) => callback(frame));
  },
  onAudioLevel: (callback) => {
    ipcRenderer.on('skipper:audio-level', (_e, level) => callback(level));
  },
  onNotification: (callback) => {
    ipcRenderer.on('skipper:notification-sent', (_e, notif) => callback(notif));
  },
  onUsageMetadata: (callback) => {
    ipcRenderer.on('skipper:usage-metadata', (_e, usage) => callback(usage));
  },
  onProviderStatus: (callback) => {
    ipcRenderer.on('skipper:provider-status', (_e, status) => callback(status));
  },
  onProviderError: (callback) => {
    ipcRenderer.on('skipper:provider-error', (_e, err) => callback(err));
  },
  onUrlChanged: (callback) => {
    ipcRenderer.on('skipper:url-changed', (_e, url) => callback(url));
  },
};

contextBridge.exposeInMainWorld('skipperAPI', api);

