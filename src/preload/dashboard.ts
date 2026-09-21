import { contextBridge, ipcRenderer } from 'electron';

export interface SkipperAPI {
  // Tab / general operations
  openBrowser: (url?: string) => Promise<void>;
  hideBrowser: () => Promise<void>;
  showBrowser: () => Promise<void>;
  startMonitoring: (prompt?: string) => Promise<void>;
  pauseMonitoring: () => Promise<void>;
  resumeMonitoring: () => Promise<void>;
  stopMonitoring: () => Promise<void>;
  getStatus: () => Promise<any>;
  setMuteLocal: (muted: boolean) => Promise<boolean>;
  testNotification: (reason?: string, summary?: string) => Promise<boolean>;

  // Config operations
  getConfig: () => Promise<any>;
  saveConfig: (config: any) => Promise<boolean>;
  savePrompts: (prompts: { systemPrompt: string; compactPrompt: string }) => Promise<boolean>;
  saveConstants: (constants: any) => Promise<boolean>;

  // Speaker tracks & Teacher resolution
  getSpeakerTracks: () => Promise<any[]>;
  setManualTeacher: (speakerId: string | null) => Promise<boolean>;
  onSpeakerTracksUpdated: (callback: (tracks: any[]) => void) => void;
  onTeacherChanged: (callback: (data: { teacherId: string; isManual: boolean; reason?: string }) => void) => void;

  // Real-time event listeners
  onStatusUpdate: (callback: (status: any) => void) => void;
  onTranscriptSegment: (callback: (segment: any) => void) => void;
  onScreeningAlert: (callback: (alert: any) => void) => void;
  onEvaluationLog: (callback: (log: any) => void) => void;
  onAudioLevel: (callback: (level: number) => void) => void;
  onUrlChanged: (callback: (url: string) => void) => void;

  // Additional pipeline helpers & backward compatibility
  completeInitialization: () => Promise<void>;
  captureSingleFrame: () => Promise<any>;
  setUserPrompt: (prompt: string) => Promise<void>;
  sendAudioChunk: (buffer: ArrayBuffer, level?: number) => void;
  onFrameProcessed: (callback: (frame: any) => void) => void;
  onNotification: (callback: (notif: any) => void) => void;
  onUsageMetadata: (callback: (usage: any) => void) => void;
  onProviderStatus: (callback: (status: string) => void) => void;
  onProviderError: (callback: (err: string) => void) => void;
}

const api: SkipperAPI = {
  // Tab / general operations
  openBrowser: (url) => ipcRenderer.invoke('skipper:open-browser', url),
  hideBrowser: () => ipcRenderer.invoke('skipper:hide-browser'),
  showBrowser: () => ipcRenderer.invoke('skipper:show-browser'),
  startMonitoring: (prompt) => ipcRenderer.invoke('skipper:start-monitoring', prompt),
  pauseMonitoring: () => ipcRenderer.invoke('skipper:pause-monitoring'),
  resumeMonitoring: () => ipcRenderer.invoke('skipper:resume-monitoring'),
  stopMonitoring: () => ipcRenderer.invoke('skipper:stop-monitoring'),
  getStatus: () => ipcRenderer.invoke('skipper:get-status'),
  setMuteLocal: (muted) => ipcRenderer.invoke('skipper:set-mute-local', muted),
  testNotification: (reason, summary) => ipcRenderer.invoke('skipper:test-notification', reason, summary),

  // Config operations
  getConfig: () => ipcRenderer.invoke('skipper:get-config'),
  saveConfig: (config) => ipcRenderer.invoke('skipper:save-config', config),
  savePrompts: (prompts) => ipcRenderer.invoke('skipper:save-prompts', prompts),
  saveConstants: (constants) => ipcRenderer.invoke('skipper:save-constants', constants),
  // Speaker tracks & Teacher resolution
  getSpeakerTracks: () => ipcRenderer.invoke('skipper:get-speaker-tracks'),
  setManualTeacher: (speakerId) => ipcRenderer.invoke('skipper:set-manual-teacher', speakerId),
  onSpeakerTracksUpdated: (callback) => {
    ipcRenderer.on('skipper:speaker-tracks-updated', (_e, tracks) => callback(tracks));
  },
  onTeacherChanged: (callback) => {
    ipcRenderer.on('skipper:teacher-changed', (_e, data) => callback(data));
  },

  // Real-time event listeners
  onStatusUpdate: (callback) => {
    ipcRenderer.on('skipper:status-update', (_e, status) => callback(status));
  },
  onTranscriptSegment: (callback) => {
    ipcRenderer.on('skipper:transcript-segment', (_e, segment) => callback(segment));
  },
  onScreeningAlert: (callback) => {
    ipcRenderer.on('skipper:screening-alert', (_e, alert) => callback(alert));
  },
  onEvaluationLog: (callback) => {
    ipcRenderer.on('skipper:evaluation-log', (_e, log) => callback(log));
  },
  onAudioLevel: (callback) => {
    ipcRenderer.on('skipper:audio-level', (_e, level) => callback(level));
  },
  onUrlChanged: (callback) => {
    ipcRenderer.on('skipper:url-changed', (_e, url) => callback(url));
  },

  // Additional pipeline helpers & backward compatibility
  completeInitialization: () => ipcRenderer.invoke('skipper:complete-init'),
  captureSingleFrame: () => ipcRenderer.invoke('skipper:capture-frame'),
  setUserPrompt: (prompt) => ipcRenderer.invoke('skipper:set-prompt', prompt),
  sendAudioChunk: (buffer, level) => {
    ipcRenderer.send('skipper:audio-chunk', Buffer.from(buffer), level);
  },
  onFrameProcessed: (callback) => {
    ipcRenderer.on('skipper:frame-processed', (_e, frame) => callback(frame));
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
};

contextBridge.exposeInMainWorld('skipperAPI', api);
