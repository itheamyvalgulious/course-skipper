import { BaseAIProvider } from './baseProvider';
import { AIProviderConfig } from './types';

export class MockAIProvider extends BaseAIProvider {
  public readonly name: string = 'MockAIProvider';
  private frameCount: number = 0;
  private audioBytesReceived: number = 0;
  private autoTestTimer: NodeJS.Timeout | null = null;

  constructor(config?: AIProviderConfig) {
    super(config);
  }

  public async connect(): Promise<void> {
    this.connected = true;
    this.emit('statusChange', 'connected');
    console.log('[MockAIProvider] Connected and ready (Mock AI)');
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
    if (this.autoTestTimer) {
      clearInterval(this.autoTestTimer);
      this.autoTestTimer = null;
    }
    this.emit('statusChange', 'disconnected');
    console.log('[MockAIProvider] Disconnected');
  }

  public async sendFrame(imageBuffer: Buffer, mimeType: string = 'image/jpeg'): Promise<void> {
    if (!this.connected) return;
    this.frameCount++;
    // In mock mode, we record that a frame was received
    if (this.frameCount % 5 === 0) {
      console.log(
        `[MockAIProvider] Ingested frame #${this.frameCount} (${imageBuffer.length} bytes, ${mimeType}). Condition: "${this.currentPrompt}"`
      );
    }
  }

  public async sendAudioChunk(chunk: Buffer): Promise<void> {
    if (!this.connected) return;
    this.audioBytesReceived += chunk.length;
  }

  /**
   * Manually trigger a notification (used by testing UI or programmatic test)
   */
  public mockTriggerNotification(
    reason: string = '满足提醒条件',
    summary: string = '检测到目标知识点讲解完毕，老师已翻页并进入下一主题'
  ): void {
    this.triggerNotification(reason, summary);
  }

  public getStats(): { frames: number; audioBytes: number } {
    return {
      frames: this.frameCount,
      audioBytes: this.audioBytesReceived,
    };
  }
}
