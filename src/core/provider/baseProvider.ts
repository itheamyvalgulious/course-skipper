import { EventEmitter } from 'events';
import { IAIProvider, NotificationTrigger, AIProviderConfig, TokenUsageMetadata } from './types';

export abstract class BaseAIProvider extends EventEmitter implements IAIProvider {
  public abstract readonly name: string;
  protected connected: boolean = false;
  protected currentPrompt: string = '';
  protected config: AIProviderConfig = {};

  constructor(config?: AIProviderConfig) {
    super();
    if (config) {
      this.config = { ...config };
      if (config.userPrompt) {
        this.currentPrompt = config.userPrompt;
      }
    }
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public setUserPrompt(prompt: string): void {
    if (this.currentPrompt !== prompt) {
      this.currentPrompt = prompt;
      this.config.userPrompt = prompt;
      this.emit('promptChange', prompt);
      console.log(`[${this.name}] Updated user prompt: "${prompt}"`);
    }
  }

  public getUserPrompt(): string {
    return this.currentPrompt;
  }

  public abstract connect(): Promise<void>;
  public abstract disconnect(): Promise<void>;
  public abstract sendFrame(imageBuffer: Buffer, mimeType?: string): Promise<void>;
  public abstract sendAudioChunk(chunk: Buffer): Promise<void>;

  public onNotificationTrigger(handler: (event: NotificationTrigger) => void): void {
    this.on('notificationTrigger', handler);
  }

  public onUsageMetadata(handler: (usage: TokenUsageMetadata) => void): void {
    this.on('usageMetadata', handler);
  }

  public onError(handler: (err: Error) => void): void {
    this.on('error', handler);
  }

  public onStatusChange(handler: (status: string) => void): void {
    this.on('statusChange', handler);
  }

  protected triggerNotification(reason: string, summary: string, currentTopic?: string): void {
    const event: NotificationTrigger = {
      reason,
      summary,
      current_topic: currentTopic,
      timestamp: Date.now(),
    };
    console.log(`[${this.name}] Triggering notification:`, event);
    this.emit('notificationTrigger', event);
  }

  protected emitUsageMetadata(usage: TokenUsageMetadata): void {
    this.emit('usageMetadata', usage);
  }
}

