import { EventEmitter } from 'events';

/**
 * Represents a recognized speech segment with timestamps and speaker information.
 */
export interface STTSegment {
  text: string;
  startTime: number; // in seconds (relative to stream start)
  endTime: number;   // in seconds (relative to stream start)
  speaker?: string;  // e.g. 'Teacher', 'Student', or speaker diarization tag
  isFinal: boolean;
}

/**
 * Supported STT Provider types:
 * - 'google': Google Cloud Speech-to-Text v1 API
 * - 'cpu': Local CPU-based provider (whisper.cpp / sherpa-onnx / rolling-window VAD)
 * - 'funasr': Alibaba Fun-ASR-Nano end-to-end Speech LLM via Sherpa-ONNX
 * - 'mock': In-memory mock provider for testing
 */
export type STTProviderType = 'google' | 'cpu' | 'funasr' | 'mock';

/**
 * Configuration options for STT Providers.
 */
export interface STTConfig {
  provider: STTProviderType;
  googleApiKey?: string;
  googleLanguageCode?: string;
  sampleRate?: number;
  rollingWindowSec?: number;
  whisperEndpoint?: string;
  enableNativeWhisper?: boolean;
  whisperBinPath?: string;
  whisperModelPath?: string;
  whisperModelSize?: 'small' | 'medium';
  enableNativeSherpa?: boolean;
  sherpaBinPath?: string;
  sherpaSegmentationModelPath?: string;
  sherpaEmbeddingModelPath?: string;
  sherpaEmbeddingModelType?: 'campplus' | 'eres2netv2';
  funasrModelDir?: string;
  funasrBinPath?: string;
  funasrLanguage?: string;
  funasrHotwords?: string;
  funasrMaxTokens?: number;
  enableNativeFunasr?: boolean;
  sileroVadModelPath?: string;
  sileroVadBinPath?: string;
  enableSileroVad?: boolean;
  manualTeacherId?: string | null;
  chunkDurationSec?: number;
  minEnergyThreshold?: number;
  transcriptFile?: string;
  [key: string]: any;
}

/**
 * Unified STT Provider interface extending EventEmitter.
 */
export interface ISTTProvider extends EventEmitter {
  readonly name: string;
  readonly isRunning: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;
  feedAudio(chunk: Buffer): void;
  reset(): void;

  on(event: 'segment', listener: (segment: STTSegment) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'status', listener: (status: string) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
