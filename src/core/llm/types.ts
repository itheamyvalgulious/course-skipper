/**
 * Skipper - LLM & Screening Engine Types
 */

export interface GoalItem {
  id: string;
  text: string;
  enabled: boolean;
}

export type GoalLogic = 'OR' | 'AND';

export interface ScreeningVerdict {
  triggered: boolean;
  matchedGoals: string[];
  confidence: number;
  currentTopic?: string;
  reason: string;
  summary: string;
}

export interface EvaluationLog {
  id: string;
  timestamp: number;
  triggerType: 'pause' | 'timeout' | 'manual';
  contextText: string;
  promptSent: string;
  rawResponse: string;
  verdict: ScreeningVerdict;
  durationMs: number;
  tokenUsage?: any;
}

export interface CompactState {
  summary: string;
  lastCompactTimestamp: number;
  compactedSegmentsCount: number;
}

export interface STTSegment {
  id?: string;
  text: string;
  startTime?: number; // in seconds or offset
  endTime?: number;
  speaker?: string;
  isFinal?: boolean;
  timestamp?: number; // epoch ms
}

export interface ISTTProvider {
  on(event: 'segment', listener: (segment: STTSegment) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  removeListener?(event: string, listener: (...args: any[]) => void): this;
  off?(event: string, listener: (...args: any[]) => void): this;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content: string;
}

export interface LLMCompletionOptions {
  model?: string;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface LLMCompletionResult {
  content: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    [key: string]: any;
  };
}
