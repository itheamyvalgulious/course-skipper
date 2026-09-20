import { ProcessingState, SkipperStatus, FrameData } from '../../common/types';

export interface ProcessingOptions {
  frameIntervalMs?: number; // default 2500 ms (2.5 seconds)
  autoStartOnReady?: boolean;
}

export interface IProcessingLayer {
  readonly state: ProcessingState;

  initialize(url?: string): Promise<boolean>;
  startMonitoring(prompt?: string): Promise<void>;
  pauseMonitoring(): void;
  resumeMonitoring(): void;
  stopMonitoring(): Promise<void>;

  setUserPrompt(prompt: string): void;
  getUserPrompt(): string;

  captureSingleFrame(): Promise<FrameData | null>;
  testNotification(reason?: string, summary?: string): Promise<boolean>;

  getStatus(): SkipperStatus;

  onStateChange(handler: (state: ProcessingState) => void): void;
  onStatusUpdate(handler: (status: SkipperStatus) => void): void;
  onFrameProcessed(handler: (frame: FrameData) => void): void;
}
