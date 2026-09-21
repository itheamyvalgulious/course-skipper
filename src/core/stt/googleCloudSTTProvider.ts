import { BaseSTTProvider } from './baseSTTProvider';
import { STTConfig, STTSegment } from './types';

/**
 * Google Cloud Speech-to-Text v1 Provider.
 * Buffers 16kHz PCM audio into configurable chunks (default ~3.5s),
 * calls Google Speech REST API, and emits synchronized STTSegments.
 */
export class GoogleCloudSTTProvider extends BaseSTTProvider {
  public readonly name: string = 'GoogleCloudSTTProvider';

  private apiKey: string = '';
  private languageCode: string = 'zh-CN';
  private chunkDurationSec: number = 3.5;
  private minEnergyThreshold: number = 0.005;
  private minChunkBytes: number;

  private audioBuffer: Buffer = Buffer.alloc(0);
  private isProcessingQueue: boolean = false;
  private chunkQueue: { chunk: Buffer; startOffsetSec: number; durationSec: number }[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(config: STTConfig) {
    super(config);
    this.apiKey = config.googleApiKey || process.env.GOOGLE_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || '';
    if (config.googleLanguageCode) {
      this.languageCode = config.googleLanguageCode;
    }
    if (config.chunkDurationSec && config.chunkDurationSec > 0) {
      this.chunkDurationSec = config.chunkDurationSec;
    }
    if (config.minEnergyThreshold !== undefined) {
      this.minEnergyThreshold = config.minEnergyThreshold;
    }

    this.minChunkBytes = this.secondsToBytes(this.chunkDurationSec);
  }

  public async start(): Promise<void> {
    if (this._isRunning) return;

    if (!this.apiKey) {
      this.emitStatus('warning');
      this.emitError(new Error('Google Cloud STT API key is missing. Please provide googleApiKey in config or environment.'));
    }

    this._isRunning = true;
    this.emitStatus('connected');
    console.log(`[${this.name}] Started (chunk: ${this.chunkDurationSec}s, lang: ${this.languageCode})`);
  }

  public async stop(): Promise<void> {
    if (!this._isRunning) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush any remaining audio if longer than 0.5s
    if (this.audioBuffer.length >= this.secondsToBytes(0.5)) {
      this.enqueueChunk(this.audioBuffer);
      this.audioBuffer = Buffer.alloc(0);
    }

    this._isRunning = false;
    this.emitStatus('stopped');
    console.log(`[${this.name}] Stopped`);
  }

  public feedAudio(chunk: Buffer): void {
    if (!this._isRunning || !chunk || chunk.length === 0) return;

    this.totalAudioBytes += chunk.length;
    this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);

    // Schedule a debounced flush timer in case audio stream pauses
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushBufferedAudio();
    }, 1500);

    // When buffer reaches configured chunk threshold, slice and enqueue
    while (this.audioBuffer.length >= this.minChunkBytes) {
      const chunkToProcess = this.audioBuffer.subarray(0, this.minChunkBytes);
      this.audioBuffer = this.audioBuffer.subarray(this.minChunkBytes);
      this.enqueueChunk(chunkToProcess);
    }
  }

  public override reset(): void {
    super.reset();
    this.audioBuffer = Buffer.alloc(0);
    this.chunkQueue = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.isProcessingQueue = false;
  }

  private flushBufferedAudio(): void {
    if (!this._isRunning || this.audioBuffer.length === 0) return;
    const minFlushBytes = this.secondsToBytes(1.0); // At least 1.0s to avoid tiny fragments
    if (this.audioBuffer.length >= minFlushBytes) {
      const chunk = this.audioBuffer;
      this.audioBuffer = Buffer.alloc(0);
      this.enqueueChunk(chunk);
    }
  }

  private enqueueChunk(chunk: Buffer): void {
    const durationSec = this.calculateDurationSec(chunk.length);
    const startOffsetSec = this.streamOffsetSec;
    this.streamOffsetSec += durationSec;

    this.chunkQueue.push({
      chunk,
      startOffsetSec,
      durationSec,
    });

    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.chunkQueue.length > 0 && this._isRunning) {
      const item = this.chunkQueue.shift();
      if (!item) break;

      try {
        await this.recognizeChunk(item.chunk, item.startOffsetSec, item.durationSec);
      } catch (err: any) {
        this.emitError(new Error(`Error processing chunk: ${err?.message || err}`));
      }
    }

    this.isProcessingQueue = false;
  }

  private async recognizeChunk(
    chunk: Buffer,
    startOffsetSec: number,
    durationSec: number
  ): Promise<void> {
    // 1. Check audio energy level for silence skipping
    const rms = this.calculateRMS(chunk);
    if (rms < this.minEnergyThreshold) {
      // Silence detected: advance without wasting API quota
      return;
    }

    // 2. Validate API key
    if (!this.apiKey) {
      this.emitError(new Error('Google Cloud STT: Unable to call API because googleApiKey is not configured.'));
      return;
    }

    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(this.apiKey)}`;
    const requestBody = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: this.sampleRate,
        languageCode: this.languageCode,
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true,
      },
      audio: {
        content: chunk.toString('base64'),
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.emitError(new Error(`Google Cloud STT API request failed (${response.status}): ${errorText}`));
        return;
      }

      const data: any = await response.json();
      this.parseAndEmitResults(data, startOffsetSec, durationSec);
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        this.emitError(new Error('Google Cloud STT request timed out'));
      } else {
        this.emitError(new Error(`Google Cloud STT network error: ${err?.message || err}`));
      }
    }
  }

  private parseAndEmitResults(
    data: any,
    chunkStartSec: number,
    chunkDurationSec: number
  ): void {
    if (!data || !data.results || !Array.isArray(data.results)) {
      return;
    }

    for (const result of data.results) {
      const alt = result.alternatives?.[0];
      if (!alt || !alt.transcript || !alt.transcript.trim()) {
        continue;
      }

      let segStart = chunkStartSec;
      let segEnd = chunkStartSec + chunkDurationSec;

      if (alt.words && Array.isArray(alt.words) && alt.words.length > 0) {
        const firstWord = alt.words[0];
        const lastWord = alt.words[alt.words.length - 1];

        if (firstWord.startTime) {
          segStart = chunkStartSec + this.parseGoogleTime(firstWord.startTime);
        }
        if (lastWord.endTime) {
          segEnd = chunkStartSec + this.parseGoogleTime(lastWord.endTime);
        }
      }

      const segment: STTSegment = {
        text: alt.transcript.trim(),
        startTime: Number(segStart.toFixed(2)),
        endTime: Number(segEnd.toFixed(2)),
        speaker: 'Teacher',
        isFinal: true,
      };

      this.emitSegment(segment);
    }
  }

  private parseGoogleTime(timeStr: string | number): number {
    if (typeof timeStr === 'number') return timeStr;
    if (!timeStr) return 0;
    const cleaned = timeStr.replace('s', '').trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
}
