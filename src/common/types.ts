/**
 * Skipper - Classroom Live Stream AI Assistant
 * Common Types
 */

export interface FrameData {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  timestamp: number;
  dataUrl?: string;
}

export interface AudioChunk {
  buffer: Buffer; // Raw PCM or WebM
  timestamp: number;
  sampleRate?: number;
  channels?: number;
  format?: 'pcm-16le' | 'webm-opus';
  level?: number; // 0.0 - 1.0 volume estimation
}

export type ProcessingState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'monitoring'
  | 'paused'
  | 'error';

export interface SkipperStatus {
  state: ProcessingState;
  browserUrl?: string;
  isBrowserOpen: boolean;
  isInitialized: boolean;
  isAudioActive?: boolean;
  isAiConnected?: boolean;
  audioLevel: number;
  userPrompt?: string;
  currentCondition?: string;
  framesProcessed: number;
  audioChunksProcessed: number;
  lastNotification?: {
    title: string;
    body: string;
    reason?: string;
    summary?: string;
    timestamp: number;
  };
  lastActiveTimestamp?: number;
}
