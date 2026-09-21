import { EventEmitter } from 'events';
import { ISTTProvider, STTConfig, STTSegment } from './types';

/**
 * Base abstract class for Speech-to-Text providers.
 * Encapsulates common state, event emitters, audio calculations, and WAV conversions.
 */
export abstract class BaseSTTProvider extends EventEmitter implements ISTTProvider {
  public abstract readonly name: string;

  protected _isRunning: boolean = false;
  protected config: STTConfig;
  protected sampleRate: number = 16000;
  protected bytesPerSample: number = 2; // 16-bit PCM = 2 bytes per sample
  protected channels: number = 1;        // Mono channel
  protected totalAudioBytes: number = 0;
  protected streamOffsetSec: number = 0;

  constructor(config: STTConfig) {
    super();
    this.config = { ...config };
    if (config.sampleRate && config.sampleRate > 0) {
      this.sampleRate = config.sampleRate;
    }
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Start the STT provider.
   */
  public abstract start(): Promise<void>;

  /**
   * Stop the STT provider and flush remaining buffers.
   */
  public abstract stop(): Promise<void>;

  /**
   * Feed raw audio chunk (16kHz 16-bit mono PCM).
   */
  public abstract feedAudio(chunk: Buffer): void;

  /**
   * Reset internal buffers, stream offset, and state.
   */
  public reset(): void {
    this.totalAudioBytes = 0;
    this.streamOffsetSec = 0;
    console.log(`[${this.name}] State reset`);
  }

  /**
   * Emit a finalized or partial STTSegment event.
   */
  protected emitSegment(segment: STTSegment): void {
    if (!this._isRunning) return;
    this.emit('segment', segment);
  }

  /**
   * Emit an error event safely without crashing if no error listener is attached.
   */
  protected emitError(err: Error): void {
    console.error(`[${this.name}] Error:`, err.message);
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Emit a status update event.
   */
  protected emitStatus(status: string): void {
    console.log(`[${this.name}] Status: ${status}`);
    this.emit('status', status);
  }

  /**
   * Calculate duration in seconds for a given PCM byte length.
   */
  public calculateDurationSec(byteLength: number): number {
    const bytesPerSec = this.sampleRate * this.bytesPerSample * this.channels;
    if (bytesPerSec === 0) return 0;
    return byteLength / bytesPerSec;
  }

  /**
   * Calculate number of PCM bytes for a given duration in seconds.
   */
  public secondsToBytes(seconds: number): number {
    return Math.floor(seconds * this.sampleRate * this.bytesPerSample * this.channels);
  }

  /**
   * Calculate Root Mean Square (RMS) energy level of 16-bit LE PCM audio.
   * Returns a normalized value between 0.0 and 1.0.
   */
  public calculateRMS(buffer: Buffer): number {
    if (buffer.length < 2) return 0;
    let sum = 0;
    const numSamples = Math.floor(buffer.length / 2);
    for (let i = 0; i < numSamples; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768.0;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / numSamples);
    return Math.min(1.0, rms);
  }

  /**
   * Prepends a standard 44-byte RIFF WAV header to raw 16-bit PCM data.
   */
  public static pcmToWav(
    pcmData: Buffer,
    sampleRate: number = 16000,
    numChannels: number = 1,
    bitDepth: number = 16
  ): Buffer {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * numChannels * (bitDepth / 8);
    const blockAlign = numChannels * (bitDepth / 8);
    const dataSize = pcmData.length;
    const chunkSize = 36 + dataSize;

    // RIFF chunk descriptor
    header.write('RIFF', 0);
    header.writeUInt32LE(chunkSize, 4);
    header.write('WAVE', 8);

    // "fmt " sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);             // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20);              // AudioFormat (1 = PCM)
    header.writeUInt16LE(numChannels, 22);    // NumChannels
    header.writeUInt32LE(sampleRate, 24);     // SampleRate
    header.writeUInt32LE(byteRate, 28);       // ByteRate
    header.writeUInt16LE(blockAlign, 32);     // BlockAlign
    header.writeUInt16LE(bitDepth, 34);       // BitsPerSample

    // "data" sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }
}
