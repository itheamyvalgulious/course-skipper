import { BaseSTTProvider } from './baseSTTProvider';
import { STTConfig, STTSegment } from './types';

/**
 * Mock STT Provider for unit tests, offline development, and CI environments.
 */
export class MockSTTProvider extends BaseSTTProvider {
  public readonly name: string = 'MockSTTProvider';

  private mockPhrases: string[] = [
    '同学们请看黑板，我们继续证明这个定理。',
    '注意柯西不等式成立的充分必要条件。',
    'OK，那这个式子就证完了对不对？',
    '听明白了没有？我们稍微等一下。',
    '好，那么下面我们进入下一个知识点。'
  ];
  private phraseIndex: number = 0;
  private minEmitBytes: number;
  private pendingBytes: number = 0;

  constructor(config: Partial<STTConfig> = {}) {
    super({
      provider: 'mock',
      sampleRate: 16000,
      ...config,
    });
    // Emit mock segment roughly every 3 seconds of audio fed
    this.minEmitBytes = this.secondsToBytes(3.0);
  }

  public async start(): Promise<void> {
    this._isRunning = true;
    this.emitStatus('connected');
    console.log(`[${this.name}] Started`);
  }

  public async stop(): Promise<void> {
    this._isRunning = false;
    this.emitStatus('stopped');
    console.log(`[${this.name}] Stopped`);
  }

  public feedAudio(chunk: Buffer): void {
    if (!this._isRunning || !chunk || chunk.length === 0) return;

    const duration = this.calculateDurationSec(chunk.length);
    this.totalAudioBytes += chunk.length;
    this.pendingBytes += chunk.length;

    const startSec = this.streamOffsetSec;
    this.streamOffsetSec += duration;

    if (this.pendingBytes >= this.minEmitBytes) {
      this.pendingBytes = 0;
      const text = this.mockPhrases[this.phraseIndex % this.mockPhrases.length];
      this.phraseIndex++;

      const segment: STTSegment = {
        text,
        startTime: Number(startSec.toFixed(2)),
        endTime: Number(this.streamOffsetSec.toFixed(2)),
        speaker: 'Teacher',
        isFinal: true,
      };

      this.emitSegment(segment);
    }
  }

  /**
   * Manually inject a mock segment for testing.
   */
  public injectSegment(segment: STTSegment): void {
    this.emitSegment(segment);
  }

  public override reset(): void {
    super.reset();
    this.pendingBytes = 0;
    this.phraseIndex = 0;
  }
}
