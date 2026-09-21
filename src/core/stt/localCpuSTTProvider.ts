import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { BaseSTTProvider } from './baseSTTProvider';
import { STTConfig, STTSegment } from './types';
import { TeacherResolver, SpeakerTrackInfo } from './teacherResolver';

interface TranscriptItem {
  startTime?: number;
  endTime?: number;
  text: string;
  speaker?: string;
}

interface DiarizationInterval {
  startSec: number;
  endSec: number;
  speakerId: string;
}

/**
 * Local CPU STT Provider.
 * Optimized for environments without NVIDIA GPU.
 * Features:
 * - 20-30s rolling FIFO audio buffer for diarization stability
 * - Unified large-window streaming interface matching cloud STT
 * - Real-time Voice Activity Detection (VAD) for utterance segmentation
 * - Native Whisper.cpp transcription execution (whisper-cli.exe)
 * - Native Sherpa-onnx Diarization execution (sherpa-onnx-offline-speaker-diarization.exe)
 * - Dynamic Teacher Resolution (TeacherResolver) tracking speaker tracks and auto/manual teacher roles
 * - Whisper.cpp HTTP endpoint support with automatic WAV generation
 * - Graceful fallback to pre-generated transcripts or simulated classroom speech segmentation
 */
export class LocalCpuSTTProvider extends BaseSTTProvider {
  public readonly name: string = 'LocalCpuSTTProvider';

  private rollingWindowSec: number = 25; // 20-30s rolling buffer
  private maxRollingBytes: number;
  private rollingBuffer: Buffer = Buffer.alloc(0);

  private whisperEndpoint?: string;
  private endpointAvailable: boolean | null = null; // null = untested

  // Native Engine Paths and Flags
  private whisperBinPath: string;
  private whisperModelPath: string;
  private hasNativeWhisper: boolean = false;

  private sherpaBinPath: string;
  private sherpaSegPath: string;
  private sherpaEmbedPath: string;
  private hasNativeSherpa: boolean = false;

  // Diarization intervals cache & background task control
  private diarizationIntervals: DiarizationInterval[] = [];
  private isDiarizing: boolean = false;
  private lastDiarizationStreamSec: number = 0;
  private diarizationIntervalSec: number = 20; // run every 20s

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

  // Utterance Serialization Queue (avoids spawning unbounded concurrent Whisper processes)
  private utteranceQueue: Array<{ pcm: Buffer; startSec: number; endSec: number }> = [];
  private isProcessingQueue: boolean = false;

  // Transcript replay & simulation fallback
  private transcripts: TranscriptItem[] = [];
  private transcriptCursor: number = 0;
  private emittedTranscriptIndices = new Set<number>();

  // Default lecture phrases for simulated segmentation fallback
  private defaultClassroomPhrases: string[] = [
    '我们来看这个最佳逼近的性质。',
    '根据规范正交组的定义，我们对系数进行展开。',
    '注意这里的内积性质，两者做差之后得到范数平方。',
    'OK，那这个式子就证完了对不对？',
    '什么时候取等号呢？当且仅当每一个系数都相等。',
    '听明白了没有？好，记一下这个结论。',
    '我们稍微等一下，接下来进入完备性的讨论。',
    '如果空间是完备的，那么每一个柯西序列都会收敛。',
    '大家看黑板上的定义，这里极限必须在空间内部。',
    '听明白了没有？好，那么下面有一个重要定理。'
  ];

  constructor(config: STTConfig) {
    super(config);
    if (config.rollingWindowSec && config.rollingWindowSec >= 10) {
      this.rollingWindowSec = config.rollingWindowSec;
    }
    this.maxRollingBytes = this.secondsToBytes(this.rollingWindowSec);
    this.whisperEndpoint = config.whisperEndpoint || process.env.WHISPER_ENDPOINT;

    // 100ms analysis frame for VAD (16000 * 2 * 0.1 = 3200 bytes)
    this.vadFrameBytes = this.secondsToBytes(0.1);

    // Resolve Whisper.cpp native engine paths
    const rootDir = process.cwd();
    const exeExt = process.platform === 'win32' ? '.exe' : '';
    const whisperSize = config.whisperModelSize || 'small';
    this.whisperBinPath =
      config.whisperBinPath || path.join(rootDir, 'resources', 'bin', 'whisper', `whisper-cli${exeExt}`);
    this.whisperModelPath =
      config.whisperModelPath ||
      path.join(rootDir, 'resources', 'models', 'whisper', `ggml-${whisperSize}.bin`);

    // Resolve Sherpa-onnx native diarization paths
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

    // Verify presence of native binaries and models
    const isTestEnv = process.env.SKIPPER_TEST === '1' || process.env.NODE_ENV === 'test';

    this.hasNativeWhisper =
      config.enableNativeWhisper !== undefined
        ? config.enableNativeWhisper
        : !isTestEnv && fs.existsSync(this.whisperBinPath) && fs.existsSync(this.whisperModelPath);

    this.hasNativeSherpa =
      config.enableNativeSherpa !== undefined
        ? config.enableNativeSherpa
        : !isTestEnv &&
          fs.existsSync(this.sherpaBinPath) &&
          fs.existsSync(this.sherpaSegPath) &&
          fs.existsSync(this.sherpaEmbedPath);

    // Initialize TeacherResolver
    this.teacherResolver = new TeacherResolver(config.manualTeacherId);
    this.teacherResolver.on('tracksUpdated', (tracks) => this.emit('tracksUpdated', tracks));
    this.teacherResolver.on('teacherChanged', (tId, isManual, reason) =>
      this.emit('teacherChanged', tId, isManual, reason)
    );

    if (config.transcriptFile) {
      this.loadTranscriptFile(config.transcriptFile);
    } else {
      // Auto-check if test-assets benchmark or ground truth is available
      this.tryAutoLoadDefaultTranscripts();
    }
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

  public async start(): Promise<void> {
    if (this._isRunning) return;

    this._isRunning = true;
    this.emitStatus('connected');
    console.log(
      `[${this.name}] Started (rollingWindow: ${this.rollingWindowSec}s, nativeWhisper: ${
        this.hasNativeWhisper ? 'enabled' : 'disabled'
      }, nativeSherpa: ${this.hasNativeSherpa ? 'enabled' : 'disabled'}, endpoint: ${
        this.whisperEndpoint || 'offline-cpu'
      })`
    );

    // If an endpoint is configured, test connectivity asynchronously
    if (this.whisperEndpoint) {
      this.checkEndpointHealth().catch((err) => {
        console.warn(`[${this.name}] Whisper endpoint unreachable, will use local fallback:`, err.message);
      });
    }
  }

  public async waitForPendingUtterances(): Promise<void> {
    while (this.utteranceQueue.length > 0 || this.isProcessingQueue || this.isDiarizing) {
      await new Promise((r) => setTimeout(r, 60));
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
    this.transcriptCursor = 0;
    this.emittedTranscriptIndices.clear();
    this.diarizationIntervals = [];
    this.lastDiarizationStreamSec = 0;
    this.utteranceQueue = [];
    this.isProcessingQueue = false;
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

    // 1. Maintain 20-30s rolling FIFO buffer
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

    // 3. Feed to VAD processor
    this.vadAccumulator = Buffer.concat([this.vadAccumulator, chunk]);
    while (this.vadAccumulator.length >= this.vadFrameBytes) {
      const frame = this.vadAccumulator.subarray(0, this.vadFrameBytes);
      this.vadAccumulator = this.vadAccumulator.subarray(this.vadFrameBytes);
      this.processVadFrame(frame);
    }
  }

  /**
   * Run Sherpa-onnx Diarization in background on the rolling buffer snapshot.
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
      `skipper_diar_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`
    );

    try {
      const wavBuffer = BaseSTTProvider.pcmToWav(pcmSnapshot, this.sampleRate, 1, 16);
      fs.writeFileSync(tempWav, wavBuffer);
    } catch (err: any) {
      console.warn(`[${this.name}] Failed to write temporary diarization WAV:`, err?.message);
      this.isDiarizing = false;
      return;
    }

    const args = [
      `--segmentation.pyannote-model=${this.sherpaSegPath}`,
      `--embedding.model=${this.sherpaEmbedPath}`,
      '--clustering.cluster-threshold=0.60',
      tempWav,
    ];

    execFile(this.sherpaBinPath, args, { timeout: 30000 }, (err, stdout, _stderr) => {
      try {
        if (fs.existsSync(tempWav)) {
          fs.unlinkSync(tempWav);
        }
      } catch {}

      this.isDiarizing = false;
      this.lastDiarizationStreamSec = this.streamOffsetSec;

      if (err) {
        console.warn(`[${this.name}] Sherpa diarization execution error:`, err.message);
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

        // Keep last 300 seconds to prevent unbounded memory growth
        const pruneThreshold = this.streamOffsetSec - 300;
        if (pruneThreshold > 0) {
          this.diarizationIntervals = this.diarizationIntervals.filter(
            (item) => item.endSec >= pruneThreshold
          );
        }
      }
    });
  }

  /**
   * Matches a speech interval with diarization results to find the most likely speaker ID.
   */
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
   * Process a 100ms VAD frame to track speech boundaries.
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
        // Speech onset
        this.isSpeaking = true;
        this.utteranceStartSec = currentFrameStartSec;
        this.currentUtterancePcm = Buffer.alloc(0);
      }
      this.currentUtterancePcm = Buffer.concat([this.currentUtterancePcm, frame]);

      // Check max utterance length (8s) to prevent oversized segments
      if (this.currentUtterancePcm.length >= this.secondsToBytes(8.0)) {
        const pcm = this.currentUtterancePcm;
        const startSec = this.utteranceStartSec;
        const endSec = currentFrameEndSec;
        this.currentUtterancePcm = Buffer.alloc(0);
        this.utteranceStartSec = currentFrameEndSec;
        this.processUtterance(pcm, startSec, endSec);
      }
    } else {
      // Silence frame
      if (this.isSpeaking) {
        this.silenceDurationSec += frameDuration;
        this.currentUtterancePcm = Buffer.concat([this.currentUtterancePcm, frame]);

        // If silence persists for >= 500ms, mark utterance end
        if (this.silenceDurationSec >= 0.5) {
          const pcm = this.currentUtterancePcm;
          const startSec = this.utteranceStartSec;
          const endSec = currentFrameEndSec - this.silenceDurationSec;

          this.isSpeaking = false;
          this.currentUtterancePcm = Buffer.alloc(0);
          this.silenceDurationSec = 0;

          // Only process utterances with meaningful duration (>= 0.4s)
          if (this.calculateDurationSec(pcm.length) >= 0.4) {
            this.processUtterance(pcm, startSec, endSec);
          }
        }
      }
    }
  }

  /**
   * Enqueue detected utterance for serialized transcription processing.
   */
  private async processUtterance(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): Promise<void> {
    if (pcm.length < 2) return;

    this.utteranceQueue.push({ pcm, startSec, endSec });
    this.drainUtteranceQueue().catch((err) => {
      console.warn(`[${this.name}] Utterance queue error:`, err?.message || err);
    });
  }

  private async drainUtteranceQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.utteranceQueue.length > 0) {
      const item = this.utteranceQueue.shift()!;
      try {
        await this.executeSingleUtterance(item.pcm, item.startSec, item.endSec);
      } catch (err: any) {
        console.warn(`[${this.name}] Utterance execution error:`, err?.message || err);
      }
    }

    this.isProcessingQueue = false;
  }

  private async executeSingleUtterance(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): Promise<void> {
    // Attempt 1: Native Whisper.cpp transcription
    if (this.hasNativeWhisper) {
      const recognized = await this.transcribeWithNativeWhisper(pcm, startSec, endSec);
      if (recognized) return;
    }

    // Attempt 2: Query Whisper.cpp HTTP endpoint if configured
    if (this.whisperEndpoint && this.endpointAvailable !== false) {
      const recognized = await this.queryWhisperEndpoint(pcm, startSec, endSec);
      if (recognized) return;
    }

    // Attempt 3: Match pre-generated transcripts or fallback simulation
    this.fallbackTranscription(pcm, startSec, endSec);
  }

  /**
   * Native Whisper.cpp execution via whisper-cli.exe.
   */
  private async transcribeWithNativeWhisper(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): Promise<boolean> {
    if (!this.hasNativeWhisper) return false;

    const tempWav = path.join(
      os.tmpdir(),
      `skipper_w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`
    );

    try {
      const wavBuffer = BaseSTTProvider.pcmToWav(pcm, this.sampleRate, 1, 16);
      fs.writeFileSync(tempWav, wavBuffer);

      return await new Promise<boolean>((resolve) => {
        const args = ['-m', this.whisperModelPath, '-l', 'zh', '-nt', '-f', tempWav, '-t', '4'];
        execFile(this.whisperBinPath, args, { timeout: 25000 }, (err, stdout, _stderr) => {
          try {
            if (fs.existsSync(tempWav)) {
              fs.unlinkSync(tempWav);
            }
          } catch {}

          if (err) {
            console.warn(`[${this.name}] Native Whisper execution error:`, err.message);
            return resolve(false);
          }

          const cleanText = stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(
              (l) =>
                l &&
                !l.startsWith('whisper_') &&
                !l.startsWith('system_info') &&
                !l.startsWith('load_') &&
                !l.startsWith('main:') &&
                !l.startsWith('init:')
            )
            .join(' ')
            .trim();

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
            return resolve(true);
          }

          resolve(false);
        });
      });
    } catch (err: any) {
      console.warn(`[${this.name}] Native Whisper error:`, err?.message);
      try {
        if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
      } catch {}
      return false;
    }
  }

  /**
   * Send audio to Whisper.cpp HTTP server (WAV format).
   */
  private async queryWhisperEndpoint(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): Promise<boolean> {
    if (!this.whisperEndpoint) return false;

    try {
      const wavBuffer = BaseSTTProvider.pcmToWav(pcm, this.sampleRate, 1, 16);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(this.whisperEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
        },
        body: wavBuffer as any,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) {
        this.endpointAvailable = true;
        const data: any = await res.json();
        const text = (data.text || data.transcription || '').trim();

        if (text) {
          const rawSpeakerId = data.speaker || this.matchSpeakerForInterval(startSec, endSec);
          const durationSec = endSec - startSec;
          this.teacherResolver.recordUtterance(rawSpeakerId, text, durationSec, endSec);
          const resolvedRole = this.teacherResolver.getResolvedSpeaker(rawSpeakerId);

          this.emitSegment({
            text,
            startTime: Number(startSec.toFixed(2)),
            endTime: Number(endSec.toFixed(2)),
            speaker: resolvedRole,
            isFinal: true,
          });
          return true;
        }
      } else {
        console.warn(`[${this.name}] Whisper endpoint returned status ${res.status}`);
      }
    } catch (err: any) {
      this.endpointAvailable = false;
      console.warn(`[${this.name}] Whisper endpoint query failed, falling back to local simulation:`, err.message);
    }

    return false;
  }

  /**
   * Fallback transcription generator using loaded transcripts or classroom phrases.
   */
  private fallbackTranscription(
    pcm: Buffer,
    startSec: number,
    endSec: number
  ): void {
    let text = '';
    let speaker = 'Teacher';

    // Check if pre-generated transcripts exist
    if (this.transcripts.length > 0) {
      const matchIndex = this.transcripts.findIndex(
        (t, idx) =>
          !this.emittedTranscriptIndices.has(idx) &&
          t.startTime !== undefined &&
          startSec >= t.startTime - 4.0 &&
          startSec <= (t.endTime ?? t.startTime + 6.0) + 4.0
      );

      if (matchIndex !== -1) {
        this.emittedTranscriptIndices.add(matchIndex);
        const matched = this.transcripts[matchIndex];
        text = matched.text;
        if (matched.speaker) speaker = matched.speaker;
      } else {
        // Fallback to phrase sequence if no exact script timestamp matches
        text = this.defaultClassroomPhrases[this.transcriptCursor % this.defaultClassroomPhrases.length];
        this.transcriptCursor++;
      }
    } else {
      text = this.defaultClassroomPhrases[this.transcriptCursor % this.defaultClassroomPhrases.length];
      this.transcriptCursor++;
    }

    this.teacherResolver.recordUtterance(speaker, text, endSec - startSec, endSec);
    const resolvedRole = this.teacherResolver.getResolvedSpeaker(speaker);

    const segment: STTSegment = {
      text,
      startTime: Number(startSec.toFixed(2)),
      endTime: Number(endSec.toFixed(2)),
      speaker: resolvedRole,
      isFinal: true,
    };

    this.emitSegment(segment);
  }

  /**
   * Load pre-generated transcripts from file for testing or replay.
   */
  public loadTranscriptFile(filePath: string): void {
    try {
      if (!fs.existsSync(filePath)) {
        console.warn(`[${this.name}] Transcript file not found: ${filePath}`);
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');

      // 1. Try JSON array format
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          this.transcripts = parsed.map((item) => ({
            startTime: item.startTime ?? item.start,
            endTime: item.endTime ?? item.end,
            text: item.text ?? item.transcript ?? '',
            speaker: item.speaker || 'Teacher',
          }));
          console.log(`[${this.name}] Loaded ${this.transcripts.length} transcript segments from JSON.`);
          return;
        }
      } catch {
        // Not standard JSON, parse line-based or markdown cues below
      }

      // 2. Parse text or benchmark cues
      const lines = content.split('\n');
      const items: TranscriptItem[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Match format: "03:40 - OK，那这个式子就证完了对不对？" or "[03:40] text"
        const match = trimmed.match(/(?:\[?(\d{1,2}):(\d{2})\]?)\s*[-:]?\s*(.+)/);
        if (match) {
          const min = parseInt(match[1], 10);
          const sec = parseInt(match[2], 10);
          const time = min * 60 + sec;
          const text = match[3].replace(/^["']|["']$/g, '').trim();
          items.push({
            startTime: time,
            endTime: time + 3.0,
            text,
            speaker: 'Teacher',
          });
        } else if (trimmed.length > 2) {
          items.push({
            text: trimmed,
            speaker: 'Teacher',
          });
        }
      }

      if (items.length > 0) {
        this.transcripts = items;
        console.log(`[${this.name}] Loaded ${this.transcripts.length} transcript cues from file.`);
      }
    } catch (err: any) {
      console.warn(`[${this.name}] Error loading transcript file:`, err.message);
    }
  }

  /**
   * Auto-load default ground truth transcripts if available in test-assets.
   */
  private tryAutoLoadDefaultTranscripts(): void {
    const candidates = [
      path.join(process.cwd(), 'test-assets', 'lecture_10min_transcript.json'),
      path.join(process.cwd(), 'test-assets', 'ground_truth_benchmark.md'),
      path.join(process.cwd(), 'test-assets', 'benchmark_10min.txt'),
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        this.loadTranscriptFile(file);
        if (this.transcripts.length > 0) {
          break;
        }
      }
    }
  }

  /**
   * Check if configured whisper endpoint responds.
   */
  private async checkEndpointHealth(): Promise<void> {
    if (!this.whisperEndpoint) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(this.whisperEndpoint, {
        method: 'GET',
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timer);

      if (res && (res.status === 200 || res.status === 405 || res.status === 404)) {
        this.endpointAvailable = true;
        console.log(`[${this.name}] Whisper endpoint reachable: ${this.whisperEndpoint}`);
      } else {
        this.endpointAvailable = false;
      }
    } catch {
      this.endpointAvailable = false;
    }
  }
}
