import { EventEmitter } from 'events';
import { FrameData, AudioChunk } from '../../common/types';

export interface CaptureFrameOptions {
  format?: 'jpeg' | 'png';
  quality?: number; // 0 - 100, default 80
}

export interface IAudioStreamSource extends EventEmitter {
  readonly isStreaming: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  // Events:
  // 'data': (chunk: AudioChunk) => void
  // 'level': (level: number) => void
  // 'error': (err: Error) => void
}

export interface InputLayerOptions {
  partition?: string;
  defaultUrl?: string;
  autoCaptureAudio?: boolean;
  muteLocalPlayback?: boolean; // default true: mute physical speakers, only stream audio to AI
}

export interface IInputLayer extends EventEmitter {
  readonly isInitialized: boolean;
  readonly isBrowserOpen: boolean;
  setMuteLocalPlayback(muted: boolean): void;
  getMuteLocalPlayback(): boolean;
  flushStorage(): Promise<void>;

  /**
   * Initializes the input layer:
   * Displays the built-in browser window, allows user direct manual operation
   * (e.g. login, open courseware/stream, play video), and waits for user interaction completion.
   */
  initialize(initialUrl?: string): Promise<boolean>;

  /**
   * Captures the current moment's image from the live browser webContents.
   */
  getCurrentFrame(options?: CaptureFrameOptions): Promise<FrameData>;

  /**
   * Gets the audio stream interface from the live browser.
   */
  getAudioStream(): IAudioStreamSource;

  /**
   * Signals that user has completed browser interaction (login + video playing).
   */
  completeInitialization(): void;

  /**
   * Open or focus the live browser window with optional target URL.
   */
  openBrowser(url?: string): Promise<void>;

  /**
   * Hide the live browser window (keeping it running in background with throttling disabled).
   */
  hideBrowser(): void;

  /**
   * Show the live browser window.
   */
  showBrowser(): void;

  /**
   * Close and cleanup the live browser.
   */
  destroy(): Promise<void>;
}
