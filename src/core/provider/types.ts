import { EventEmitter } from 'events';

export interface NotificationTrigger {
  reason: string;
  summary: string;
  current_topic?: string;
  timestamp: number;
}

export interface TokenModalityDetail {
  modality: string;
  tokenCount: number;
}

export interface TokenUsageMetadata {
  promptTokenCount: number;
  responseTokenCount: number;
  totalTokenCount: number;
  promptTokensDetails?: TokenModalityDetail[];
  candidatesTokensDetails?: TokenModalityDetail[];
}

export type AIBackendType = 'aistudio' | 'vertex' | 'mock';

export interface AIProviderConfig {
  apiKey?: string;
  model?: string;
  backendType?: AIBackendType; // 'aistudio' (Google AI Studio) | 'vertex' (Google Cloud Vertex AI) | 'mock'
  vertexProject?: string;
  vertexLocation?: string;
  endpoint?: string;
  useMockServer?: boolean;
  systemInstruction?: string;
  userPrompt?: string; // e.g. "这个证明结束以后叫我"
  [key: string]: any;
}

export interface IAIProvider extends EventEmitter {
  readonly name: string;
  readonly isConnected: boolean;

  /**
   * Connect to the AI service (e.g. establish Gemini Live session or initialize mock)
   */
  connect(): Promise<void>;

  /**
   * Disconnect from AI service
   */
  disconnect(): Promise<void>;

  /**
   * Update the user condition / prompt (e.g. "Fatou引理讲完后叫我")
   */
  setUserPrompt(prompt: string): void;

  /**
   * Get the current user prompt
   */
  getUserPrompt(): string;

  /**
   * Send a video/presentation frame image to the AI session
   */
  sendFrame(imageBuffer: Buffer, mimeType?: string): Promise<void>;

  /**
   * Send an audio chunk to the AI session
   */
  sendAudioChunk(chunk: Buffer): Promise<void>;

  /**
   * Send periodic heartbeat evaluation prompt to trigger reasoning turn in Gemini Live
   */
  sendHeartbeat?(): Promise<void>;

  /**
   * Listen for AI-initiated notification calls (e.g. when Gemini Live calls notify_user(reason, summary, current_topic))
   */
  onNotificationTrigger(handler: (event: NotificationTrigger) => void): void;

  /**
   * Listen for token usage metadata updates
   */
  onUsageMetadata?(handler: (usage: TokenUsageMetadata) => void): void;

  /**
   * Listen for provider errors
   */
  onError(handler: (err: Error) => void): void;

  /**
   * Listen for provider connection/status changes
   */
  onStatusChange(handler: (status: string) => void): void;
}

