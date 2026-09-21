import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { BaseSTTProvider } from './baseSTTProvider';
import { STTConfig, STTSegment } from './types';
import { TeacherResolver, SpeakerTrackInfo } from './teacherResolver';
import { SileroVadDetector } from './sileroVadDetector';

interface DiarizationInterval {
  startSec: number;
  endSec: number;
  speakerId: string;
}

/**
 * Fun-ASR-Nano STT Provider.
 * Integrates Alibaba's ~800M end-to-end Speech LLM (Audio Encoder + Adaptor + Qwen 0.6B LLM)
 * via Sherpa-ONNX native C++ engine with Silero-VAD deep learning voice activity detection.
 *
 * Strict Fail-Fast Policy:
 * If the engine binary or model files are missing, start() throws an explicit Error immediately.
 * No simulated or canned text fallback is permitted.
 */
export class FunAsrNanoSTTProvider extends BaseSTTProvider {
  public readonly name: string = 'FunAsrNanoSTTProvider';

  private rollingWindowSec: number = 25;
  private maxRollingBytes: number;
  private rollingBuffer: Buffer = Buffer.alloc(0);

  // Silero-VAD Neural Voice Activity Detector
  private sileroVad: SileroVadDetector;

  // Native Fun-ASR-Nano paths
  private funasrBinPath: string;
  private funasrModelDir: string;
  private encoderAdaptorPath: string = '';
  private llmPath: string = '';
  private embeddingPath: string = '';
  private tokenizerDir: string = '';
  private language: string = 'zh';
  private hotwords: string = '';

  // Sherpa Diarization
  private sherpaBinPath: string;
  private sherpaSegPath: string;
  private sherpaEmbedPath: string;
  private hasNativeSherpa: boolean = false;
  private diarizationIntervals: DiarizationInterval[] = [];
  private isDiarizing: boolean = false;
  private lastDiarizationStreamSec: number = 0;
  private diarizationIntervalSec: number = 20;

  // Teacher Resolver for speaker track management
  private teacherResolver: TeacherResolver;

  // VAD and utterance detection
  private vadFrameBytes: number;
  private vadAccumulator: Buffer = Buffer.alloc(0);
  private vadProcessedBytes: number = 0;
  private speechEnergyThreshold: number = 0.012;
  private silenceDurationSec: number = 0;
  private currentUtterancePcm: Buffer = Buffer.alloc(0);
  private utteranceStartSec: number = 0;
  private isSpeaking: boolean = false;

  // Utterance Serialization Queue
  private utteranceQueue: Array<{ pcm: Buffer; startSec: number; endSec: number }> = [];
  private isProcessingQueue: boolean = false;
  private vadPendingCount: number = 0;

  constructor(config: STTConfig) {
    super(config);
    if (config.rollingWindowSec && config.rollingWindowSec >= 10) {
      this.rollingWindowSec = config.rollingWindowSec;
    }
    this.maxRollingBytes = this.secondsToBytes(this.rollingWindowSec);

    // 100ms analysis frame for VAD (16000 * 2 * 0.1 = 3200 bytes)
    this.vadFrameBytes = this.secondsToBytes(0.1);

    const rootDir = process.cwd();
    const exeExt = process.platform === 'win32' ? '.exe' : '';
    this.funasrBinPath =
      config.funasrBinPath ||
      path.join(rootDir, 'resources', 'bin', 'sherpa', `sherpa-onnx-offline${exeExt}`);
    this.funasrModelDir =
      config.funasrModelDir || path.join(rootDir, 'resources', 'models', 'funasr-nano');
    this.language = config.funasrLanguage || config.googleLanguageCode?.split('-')[0] || 'zh';
    this.hotwords = config.funasrHotwords || '';

    // Diarization configuration
    const sherpaEmbedType = config.sherpaEmbeddingModelType || 'campplus';
    const embedFileName =
      sherpaEmbedType === 'eres2netv2'
        ? '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx'
        : '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';

    this.sherpaBinPath =
      config.sherpaBinPath ||
      path.join(rootDir, 'resources', 'bin', 'sherpa', `sherpa-onnx-offline-speaker-diarization${exeExt}`);
    this.sherpaSegPath =
      config.sherpaSegmentationModelPath ||
      path.join(
        rootDir,
        'resources',
        'models',
        'sherpa',
        'sherpa-onnx-pyannote-segmentation-3-0',
        'model.onnx'
      );
    this.sherpaEmbedPath =
      config.sherpaEmbeddingModelPath ||
      path.join(rootDir, 'resources', 'models', 'sherpa', embedFileName);

    this.hasNativeSherpa =
      fs.existsSync(this.sherpaBinPath) &&
      fs.existsSync(this.sherpaSegPath) &&
      fs.existsSync(this.sherpaEmbedPath);

    // Initialize TeacherResolver
    this.teacherResolver = new TeacherResolver(config.manualTeacherId);
    this.teacherResolver.on('tracksUpdated', (tracks) => this.emit('tracksUpdated', tracks));
    this.teacherResolver.on('teacherChanged', (tId, isManual, reason) =>
      this.emit('teacherChanged', tId, isManual, reason)
    );

    // Initialize Silero-VAD Detector
    this.sileroVad = new SileroVadDetector({
      vadBinPath: config.sileroVadBinPath,
      vadModelPath: config.sileroVadModelPath,
      threshold: 0.5,
      minSpeechDuration: 0.3,
    });

    // Resolve Fun-ASR-Nano model component files
    this.resolveModelFiles();
  }

  /**
   * Helper to locate model files in the target directory recursively or directly.
   */
  private findFile(dir: string, fileName: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const directPath = path.join(dir, fileName);
    if (fs.existsSync(directPath)) return directPath;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = this.findFile(fullPath, fileName);
          if (found) return found;
        } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
          return fullPath;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Resolves the 4 essential components of Fun-ASR-Nano:
   * 1. encoder_adaptor (.int8.onnx or .onnx)
   * 2. llm (.int8.onnx or .onnx)
   * 3. embedding (.int8.onnx or .onnx)
   * 4. tokenizer directory (e.g. Qwen3-0.6B)
   */
  private resolveModelFiles(): void {
    if (!fs.existsSync(this.funasrModelDir)) return;

    this.encoderAdaptorPath =
      this.findFile(this.funasrModelDir, 'encoder_adaptor.int8.onnx') ||
      this.findFile(this.funasrModelDir, 'encoder_adaptor.onnx') ||
      '';

    this.llmPath =
      this.findFile(this.funasrModelDir, 'llm.int8.onnx') ||
      this.findFile(this.funasrModelDir, 'llm.onnx') ||
      '';

    this.embeddingPath =
      this.findFile(this.funasrModelDir, 'embedding.int8.onnx') ||
      this.findFile(this.funasrModelDir, 'embedding.onnx') ||
      '';

    const qwenSubdir = path.join(this.funasrModelDir, 'Qwen3-0.6B');
    if (fs.existsSync(qwenSubdir)) {
      this.tokenizerDir = qwenSubdir;
    } else {
      const tokenizerJson = this.findFile(this.funasrModelDir, 'tokenizer.json');
      if (tokenizerJson) {
        this.tokenizerDir = path.dirname(tokenizerJson);
      }
    }
  }

  /**
   * Validates whether all required Fun-ASR-Nano components exist.
   */
  public isModelReady(): boolean {
    return (
      Boolean(this.funasrBinPath && fs.existsSync(this.funasrBinPath)) &&
      Boolean(this.encoderAdaptorPath && fs.existsSync(this.encoderAdaptorPath)) &&
      Boolean(this.llmPath && fs.existsSync(this.llmPath)) &&
      Boolean(this.embeddingPath && fs.existsSync(this.embeddingPath)) &&
      Boolean(this.tokenizerDir && fs.existsSync(this.tokenizerDir))
    );
  }

  public getModelDetails(): {
    binPath: string;
    modelDir: string;
    encoderAdaptor: string;
    llm: string;
    embedding: string;
    tokenizer: string;
    isReady: boolean;
  } {
    return {
      binPath: this.funasrBinPath,
      modelDir: this.funasrModelDir,
      encoderAdaptor: this.encoderAdaptorPath,
      llm: this.llmPath,
      embedding: this.embeddingPath,
      tokenizer: this.tokenizerDir,
      isReady: this.isModelReady(),
    };
  }

  public getTeacherResolver(): TeacherResolver {
    return this.teacherResolver;
  }

  public getSpeakerTracks(): SpeakerTrackInfo[] {
    return this.teacherResolver.getSpeakerTracks();
  }

  public setManualTeacher(speakerId: string | null): void {
    this.teacherResolver.setManualTeacher(speakerId);
  }

  public getSileroVad(): SileroVadDetector {
    return this.sileroVad;
  }

  public async start(): Promise<void> {
    if (this._isRunning) return;

    this.resolveModelFiles();

    // Strict Fail-Fast Check for Fun-ASR-Nano
    if (!fs.existsSync(this.funasrBinPath)) {
      const err = new Error(
        `[FunAsrNanoSTTProvider] Sherpa-onnx binary not found at: ${this.funasrBinPath}. Please run "npm run download:stt" to install it.`
      );
      this.emit('error', err);
      throw err;
    }

    const missingComponents: string[] = [];
    if (!this.encoderAdaptorPath || !fs.existsSync(this.encoderAdaptorPath)) {
      missingComponents.push('encoder_adaptor.int8.onnx');
    }
    if (!this.llmPath || !fs.existsSync(this.llmPath)) {
      missingComponents.push('llm.int8.onnx');
    }
    if (!this.embeddingPath || !fs.existsSync(this.embeddingPath)) {
      missingComponents.push('embedding.int8.onnx');
    }
    if (!this.tokenizerDir || !fs.existsSync(this.tokenizerDir)) {
      missingComponents.push('tokenizer (Qwen3-0.6B)');
    }

    if (missingComponents.length > 0) {
      const err = new Error(
        `[FunAsrNanoSTTProvider] Fun-ASR-Nano model files missing in "${this.funasrModelDir}": [${missingComponents.join(
          ', '
        )}]. Please run "npm run download:funasr" to download the model package.`
      );
      this.emit('error', err);
      throw err;
    }

    // Strict Fail-Fast Check for Silero-VAD
    try {
      this.sileroVad.verifyModelPresence();
    } catch (err: any) {
      this.emit('error', err);
      throw err;
    }

    this._isRunning = true;
    this.emitStatus('connected');
    console.log(
      `[${this.name}] Started successfully with Fun-ASR-Nano (bin: ${this.funasrBinPath}, modelDir: ${this.funasrModelDir}) & Silero-VAD (model: ${this.sileroVad.getModelPath()})`
    );
  }

  public async waitForPendingUtterances(): Promise<void> {
    if (this.currentUtterancePcm.length >= this.secondsToBytes(0.4)) {
      const currentEndSec = this.calculateDurationSec(this.vadProcessedBytes);
      this.processUtterance(this.currentUtterancePcm, this.utteranceStartSec, currentEndSec);
      this.currentUtterancePcm = Buffer.alloc(0);
    }
    while (
      this.vadPendingCount > 0 ||
      this.utteranceQueue.length > 0 ||
      this.isProcessingQueue ||
      this.isDiarizing
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  public async stop(): Promise<void> {
    if (!this._isRunning) return;

    // Flush any pending utterance if speaking
    if (this.currentUtterancePcm.length >= this.secondsToBytes(0.4)) {
      const currentEndSec = this.calculateDurationSec(this.vadProcessedBytes);
      await this.processUtterance(this.currentUtterancePcm, this.utteranceStartSec, currentEndSec);
      this.currentUtterancePcm = Buffer.alloc(0);
    }

    await this.waitForPendingUtterances();

    this._isRunning = false;
    this.emitStatus('stopped');
    console.log(`[${this.name}] Stopped`);
  }

  public override reset(): void {
    super.reset();
    this.rollingBuffer = Buffer.alloc(0);
    this.vadAccumulator = Buffer.alloc(0);
    this.vadProcessedBytes = 0;
    this.currentUtterancePcm = Buffer.alloc(0);
    this.silenceDurationSec = 0;
    this.isSpeaking = false;
    this.diarizationIntervals = [];
    this.lastDiarizationStreamSec = 0;
    this.utteranceQueue = [];
    this.isProcessingQueue = false;
    this.vadPendingCount = 0;
    this.teacherResolver.reset();
  }

  /**
   * Feed raw audio chunk (16kHz 16-bit mono PCM).
   */
  public feedAudio(chunk: Buffer): void {
    if (!this._isRunning || !chunk || chunk.length === 0) return;

    const chunkDuration = this.calculateDurationSec(chunk.length);
    this.streamOffsetSec += chunkDuration;
    this.totalAudioBytes += chunk.length;

    // 1. Maintain rolling buffer for diarization
    this.rollingBuffer = Buffer.concat([this.rollingBuffer, chunk]);
    if (this.rollingBuffer.length > this.maxRollingBytes) {
      const overflow = this.rollingBuffer.length - this.maxRollingBytes;
      this.rollingBuffer = this.rollingBuffer.subarray(overflow);
    }

    // 2. Trigger periodic background diarization on rolling buffer
    if (
      this.hasNativeSherpa &&
      !this.isDiarizing &&
      this.streamOffsetSec - this.lastDiarizationStreamSec >= this.diarizationIntervalSec &&
      this.rollingBuffer.length >= this.secondsToBytes(8)
    ) {
      this.triggerBackgroundDiarization();
    }

    // 3. Feed into VAD frame processor
    this.vadAccumulator = Buffer.concat([this.vadAccumulator, chunk]);
    while (this.vadAccumulator.length >= this.vadFrameBytes) {
      const frame = this.vadAccumulator.subarray(0, this.vadFrameBytes);
      this.vadAccumulator = this.vadAccumulator.subarray(this.vadFrameBytes);
      this.processVadFrame(frame);
    }
  }

  /**
   * Run background Sherpa diarization on rolling buffer.
   */
  private triggerBackgroundDiarization(): void {
    if (this.isDiarizing || !this.hasNativeSherpa || this.rollingBuffer.length < this.secondsToBytes(8)) {
      return;
    }

    this.isDiarizing = true;
    const pcmSnapshot = Buffer.from(this.rollingBuffer);
    const bufferDurationSec = this.calculateDurationSec(pcmSnapshot.length);
    const bufferStartStreamSec = Math.max(0, this.streamOffsetSec - bufferDurationSec);

    const tempWav = path.join(
      os.tmpdir(),
      `skipper_fn_diar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`
    );

    try {
      const wavBuffer = BaseSTTProvider.pcmToWav(pcmSnapshot, this.sampleRate, 1, 16);
      fs.writeFileSync(tempWav, wavBuffer);
    } catch (err: any) {
      console.warn(`[${this.name}] Failed to write temp diarization WAV:`, err?.message);
      this.isDiarizing = false;
      return;
    }

    const args = [
      `--segmentation.pyannote-model=${this.sherpaSegPath}`,
      `--embedding.model=${this.sherpaEmbedPath}`,
      '--clustering.cluster-threshold=0.60',
      tempWav,
    ];

    execFile(this.sherpaBinPath, args, { timeout: 30000 }, (err, stdout) => {
      try {
        if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
      } catch {}

      this.isDiarizing = false;
      this.lastDiarizationStreamSec = this.streamOffsetSec;

      if (err) {
        console.warn(`[${this.name}] Diarization error:`, err.message);
        return;
      }

      const newIntervals: DiarizationInterval[] = [];
      const lines = stdout.split('\n');
      for (const line of lines) {
        const m = line.trim().match(/^([\d\.]+)\s*--\s*([\d\.]+)\s+(\S+)/);
        if (m) {
          const localStart = parseFloat(m[1]);
          const localEnd = parseFloat(m[2]);
          const spk = m[3].trim();
          newIntervals.push({
            startSec: Number((bufferStartStreamSec + localStart).toFixed(2)),
            endSec: Number((bufferStartStreamSec + localEnd).toFixed(2)),
            speakerId: spk,
          });
        }
      }

      if (newIntervals.length > 0) {
        this.diarizationIntervals = this.diarizationIntervals
          .filter((item) => item.endSec < bufferStartStreamSec || item.startSec > this.streamOffsetSec)
          .concat(newIntervals)
          .sort((a, b) => a.startSec - b.startSec);

        const pruneThreshold = this.streamOffsetSec - 300;
        if (pruneThreshold > 0) {
          this.diarizationIntervals = this.diarizationIntervals.filter(
            (item) => item.endSec >= pruneThreshold
          );
        }
      }
    });
  }

  private matchSpeakerForInterval(startSec: number, endSec: number): string {
    if (this.diarizationIntervals.length === 0) {
      return this.teacherResolver.getActiveTeacherId() || 'speaker_00';
    }

    let bestSpeaker = '';
    let maxOverlap = 0;

    for (const item of this.diarizationIntervals) {
      const overlapStart = Math.max(startSec, item.startSec);
      const overlapEnd = Math.min(endSec, item.endSec);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestSpeaker = item.speakerId;
      }
    }

    if (bestSpeaker && maxOverlap >= 0.2) {
      return bestSpeaker;
    }

    let closestSpeaker = '';
    let minDistance = Infinity;
    for (const item of this.diarizationIntervals) {
      const dist = Math.min(Math.abs(startSec - item.endSec), Math.abs(endSec - item.startSec));
      if (dist < minDistance && dist < 2.5) {
        minDistance = dist;
        closestSpeaker = item.speakerId;
      }
    }

    return closestSpeaker || this.teacherResolver.getActiveTeacherId() || 'speaker_00';
  }

  /**
   * Process 100ms VAD frame to detect speech boundaries.
   */
  private processVadFrame(frame: Buffer): void {
    const frameDuration = this.calculateDurationSec(frame.length);
    this.vadProcessedBytes += frame.length;
    const currentFrameEndSec = this.calculateDurationSec(this.vadProcessedBytes);
    const currentFrameStartSec = Math.max(0, currentFrameEndSec - frameDuration);

    const rms = this.calculateRMS(frame);
    const isSpeechFrame = rms >= this.speechEnergyThreshold;

    if (isSpeechFrame) {
      this.silenceDurationSec = 0;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.utteranceStartSec = currentFrameStartSec;
        this.currentUtterancePcm = Buffer.alloc(0);
      }
      this.currentUtterancePcm = Buffer.concat([this.currentUtterancePcm, frame]);

      // 8s max length per utterance chunk
      if (this.currentUtterancePcm.length >= this.secondsToBytes(8.0)) {
        const pcm = this.currentUtterancePcm;
        const startSec = this.utteranceStartSec;
        const endSec = currentFrameEndSec;
        this.currentUtterancePcm = Buffer.alloc(0);
        this.utteranceStartSec = currentFrameEndSec;
        this.processUtterance(pcm, startSec, endSec);
      }
    } else {
      if (this.isSpeaking) {
        this.silenceDurationSec += frameDuration;
        this.currentUtterancePcm = Buffer.concat([this.currentUtterancePcm, frame]);

        if (this.silenceDurationSec >= 0.5) {
          const pcm = this.currentUtterancePcm;
          const startSec = this.utteranceStartSec;
          const endSec = currentFrameEndSec - this.silenceDurationSec;

          this.isSpeaking = false;
          this.currentUtterancePcm = Buffer.alloc(0);
          this.silenceDurationSec = 0;

          if (this.calculateDurationSec(pcm.length) >= 0.4) {
            this.processUtterance(pcm, startSec, endSec);
          }
        }
      }
    }
  }

  private async processUtterance(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): Promise<void> {
    if (pcm.length < 2) return;
    this.vadPendingCount++;

    try {
      // Neural Silero-VAD Gate: reject non-speech (chalk clicks, paper shuffling, background hum)
      const vadResult = await this.sileroVad.detectSpeech(pcm);
      if (!vadResult.hasSpeech || vadResult.totalSpeechSec < 0.3) {
        return;
      }

      this.utteranceQueue.push({ pcm, startSec, endSec });
      this.drainUtteranceQueue().catch((err) => {
        console.warn(`[${this.name}] Utterance queue error:`, err?.message || err);
      });
    } catch (err: any) {
      console.warn(`[${this.name}] Silero-VAD evaluation warning:`, err?.message);
    } finally {
      this.vadPendingCount--;
    }
  }

  private async drainUtteranceQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.utteranceQueue.length > 0) {
      const item = this.utteranceQueue.shift()!;
      try {
        await this.executeSingleUtterance(item.pcm, item.startSec, item.endSec);
      } catch (err: any) {
        this.emit('error', err);
        console.error(`[${this.name}] Utterance execution failed:`, err?.message || err);
      }
    }

    this.isProcessingQueue = false;
    if (this.utteranceQueue.length > 0) {
      this.drainUtteranceQueue().catch(() => {});
    }
  }

  /**
   * Filters and normalizes degenerative repetition loops and noise hallucinations.
   */
  public cleanDegenerateRepetitions(text: string): string {
    if (!text || text.trim().length === 0) return '';
    let cleaned = text.trim();

    // 1. Single character infinite repetition loop (e.g. "执执执执执执...")
    // If text consists of 4+ repetitions of 1-2 characters, it's 100% noise hallucination -> drop completely
    if (/^(.{1,2})\1{3,}$/u.test(cleaned)) {
      return '';
    }

    // Deduplicate repeated single characters embedded in sentence: e.g. "执执执执执" -> "执执"
    cleaned = cleaned.replace(/(.)\1{3,}/gu, '$1$1');

    // 2. Repeated words/phrases / token loops (e.g. "isthis isthis isthis...", "task task task...", "对的对的对的...")
    cleaned = cleaned.replace(/(.{2,15}?)(?:[\s,，、\.]*\1){2,}/giu, '$1');

    // 3. Web video training artifact hallucinations (watermark / streamer prompts like "喜欢我的视频请帮我点个赞")
    cleaned = cleaned.replace(
      /(喜欢我(的)?视频|请帮我点个赞|帮我点赞|支持我.*点赞|订阅我的频道|求关注|点赞投币|我是小文)/gu,
      ''
    );

    // 4. For Chinese lectures: filter out standalone non-Chinese noise hallucinations
    // (e.g. "Is that all you can do", "game of course", "lincoln", "ofgo", "those are")
    if (this.language === 'zh' && !/[\u4e00-\u9fa5]/u.test(cleaned)) {
      return '';
    }

    return cleaned.trim();
  }

  /**
   * Executes Fun-ASR-Nano recognition via sherpa-onnx-offline.exe.
   * Emits recognized STTSegment on success, emits error on failure.
   */
  private async executeSingleUtterance(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): Promise<void> {
    const tempWav = path.join(
      os.tmpdir(),
      `skipper_funasr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`
    );

    try {
      const wavBuffer = BaseSTTProvider.pcmToWav(pcm, this.sampleRate, 1, 16);
      fs.writeFileSync(tempWav, wavBuffer);

      const args = [
        `--funasr-nano-encoder-adaptor=${this.encoderAdaptorPath}`,
        `--funasr-nano-llm=${this.llmPath}`,
        `--funasr-nano-embedding=${this.embeddingPath}`,
        `--funasr-nano-tokenizer=${this.tokenizerDir}`,
        `--funasr-nano-max-new-tokens=128`,
        '--funasr-nano-itn=true',
        '--print-args=false',
        '--num-threads=4',
      ];

      if (this.language) {
        args.push(`--funasr-nano-language=${this.language}`);
      }
      if (this.hotwords) {
        args.push(`--funasr-nano-hotwords=${this.hotwords}`);
      }

      args.push(tempWav);

      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          this.funasrBinPath,
          args,
          { timeout: 45000, encoding: 'utf-8' },
          (err, out, stderr) => {
            try {
              if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
            } catch {}

            if (err) {
              const errMsg = `Fun-ASR-Nano execution failed: ${err.message}. Stderr: ${stderr}`;
              return reject(new Error(errMsg));
            }
            resolve(out || '');
          }
        );
      });

      // Parse JSON output from sherpa-onnx
      let cleanText = '';
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*"text"\s*:\s*".*?"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          cleanText = (parsed.text || '').trim();
        }
      } catch {}

      if (!cleanText) {
        cleanText = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !l.startsWith('{') &&
              !l.startsWith('Done!') &&
              !l.startsWith('Started') &&
              !l.startsWith('Creating') &&
              !l.startsWith('OfflineRecognizerConfig') &&
              !l.startsWith('num threads:') &&
              !l.startsWith('decoding method:') &&
              !l.startsWith('Elapsed seconds:') &&
              !l.startsWith('Real time factor') &&
              !l.startsWith('----')
          )
          .join(' ')
          .trim();
      }

      // Apply degenerate repetition loop cleaner & noise hallucination filter
      cleanText = this.cleanDegenerateRepetitions(cleanText);

      if (cleanText.length > 0) {
        const rawSpeakerId = this.matchSpeakerForInterval(startSec, endSec);
        const durationSec = endSec - startSec;
        this.teacherResolver.recordUtterance(rawSpeakerId, cleanText, durationSec, endSec);
        const resolvedRole = this.teacherResolver.getResolvedSpeaker(rawSpeakerId);

        this.emitSegment({
          text: cleanText,
          startTime: Number(startSec.toFixed(2)),
          endTime: Number(endSec.toFixed(2)),
          speaker: resolvedRole,
          isFinal: true,
        });
      }
    } catch (err: any) {
      try {
        if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
      } catch {}
      throw err;
    }
  }
}
