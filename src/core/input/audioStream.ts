import { EventEmitter } from 'events';
import { IAudioStreamSource } from './types';
import { AudioChunk } from '../../common/types';

function toBuffer(input: any): Buffer {
  if (!input) return Buffer.alloc(0);
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }
  if (typeof input === 'string') {
    if (/^\s*\d+(\s*,\s*\d+)*\s*$/.test(input)) {
      const numbers = input.split(',').map((n) => parseInt(n.trim(), 10));
      return Buffer.from(numbers);
    }
    return Buffer.from(input, 'base64');
  }
  return Buffer.from(input);
}

export class AudioStreamSource extends EventEmitter implements IAudioStreamSource {
  private streaming: boolean = false;
  private paused: boolean = false;
  private chunkCount: number = 0;
  private totalBytes: number = 0;

  constructor() {
    super();
  }

  public get isStreaming(): boolean {
    return this.streaming && !this.paused;
  }

  public async start(): Promise<void> {
    this.streaming = true;
    this.paused = false;
    this.emit('start');
    console.log('[AudioStreamSource] Audio stream started');
  }

  public async stop(): Promise<void> {
    this.streaming = false;
    this.paused = false;
    this.emit('stop');
    console.log('[AudioStreamSource] Audio stream stopped');
  }

  public pause(): void {
    this.paused = true;
    this.emit('pause');
    console.log('[AudioStreamSource] Audio stream paused');
  }

  public resume(): void {
    if (this.streaming) {
      this.paused = false;
      this.emit('resume');
      console.log('[AudioStreamSource] Audio stream resumed');
    }
  }

  /**
   * Push incoming audio chunk (from capturer renderer)
   */
  public pushChunk(rawBuffer: Buffer | Uint8Array | ArrayBuffer, level?: number, format: 'pcm-16le' | 'webm-opus' = 'pcm-16le'): void {
    if (!this.streaming || this.paused) return;

    const buf = toBuffer(rawBuffer);
    this.chunkCount++;
    this.totalBytes += buf.length;

    // Estimate RMS level if not provided
    const calculatedLevel = level !== undefined ? level : this.calculateRMS(buf);

    const chunk: AudioChunk = {
      buffer: buf,
      timestamp: Date.now(),
      sampleRate: 16000,
      channels: 1,
      format,
      level: calculatedLevel,
    };

    this.emit('data', chunk);
    this.emit('level', calculatedLevel);
  }

  public getStats(): { chunks: number; bytes: number } {
    return {
      chunks: this.chunkCount,
      bytes: this.totalBytes,
    };
  }

  private calculateRMS(buffer: Buffer): number {
    if (buffer.length < 2) return 0;
    let sum = 0;
    const numSamples = Math.floor(buffer.length / 2);
    for (let i = 0; i < numSamples; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768.0;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / numSamples);
    return Math.min(1.0, rms * 3.0); // Boost for UI visual meter
  }
}
