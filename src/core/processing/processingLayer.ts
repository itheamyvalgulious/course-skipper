import { EventEmitter } from 'events';
import { IInputLayer } from '../input/types';
import { IActionLayer } from '../action/types';
import { ISTTProvider, STTSegment } from '../stt';
import { ScreeningEngine, ScreeningVerdict, EvaluationLog } from '../llm';
import { IProcessingLayer, ProcessingOptions } from './types';
import { ProcessingState, SkipperStatus, FrameData, AudioChunk } from '../../common/types';

export class ProcessingLayer extends EventEmitter implements IProcessingLayer {
  private inputLayer: IInputLayer;
  private actionLayer: IActionLayer;
  private sttProvider: ISTTProvider;
  private screeningEngine: ScreeningEngine;

  private _state: ProcessingState = 'idle';
  private frameIntervalMs: number = 2500;
  private frameTimer: NodeJS.Timeout | null = null;
  private isCapturing: boolean = false;
  private autoStartOnReady: boolean = true;

  private userPrompt: string = '当老师讲完当前知识点或证明时叫我';
  private framesProcessedCount: number = 0;
  private audioChunksProcessedCount: number = 0;
  private currentAudioLevel: number = 0;
  private lastNotificationInfo?: SkipperStatus['lastNotification'];

  constructor(
    inputLayer: IInputLayer,
    actionLayer: IActionLayer,
    sttProvider: ISTTProvider,
    screeningEngine: ScreeningEngine,
    options: ProcessingOptions = {}
  ) {
    super();
    this.inputLayer = inputLayer;
    this.actionLayer = actionLayer;
    this.sttProvider = sttProvider;
    this.screeningEngine = screeningEngine;

    if (options.frameIntervalMs) {
      this.frameIntervalMs = options.frameIntervalMs;
    }
    if (options.autoStartOnReady !== undefined) {
      this.autoStartOnReady = options.autoStartOnReady;
    }

    this.setupListeners();
  }

  public get state(): ProcessingState {
    return this._state;
  }

  public getSTTProvider(): ISTTProvider {
    return this.sttProvider;
  }

  public setSTTProvider(provider: ISTTProvider): void {
    if (this.sttProvider === provider) return;
    const wasRunning = this.sttProvider.isRunning;
    if (wasRunning) {
      this.sttProvider.stop().catch(() => {});
    }
    this.sttProvider = provider;
    this.screeningEngine.attachSTT(provider);
    this.setupSTTListeners();
    if (wasRunning && this._state === 'monitoring') {
      this.sttProvider.start().catch((err) => {
        console.error('[ProcessingLayer] Error starting new STT provider:', err);
      });
    }
  }

  public getScreeningEngine(): ScreeningEngine {
    return this.screeningEngine;
  }

  public getSpeakerTracks(): any[] {
    if (typeof (this.sttProvider as any).getSpeakerTracks === 'function') {
      return (this.sttProvider as any).getSpeakerTracks();
    }
    return [];
  }

  public setManualTeacher(speakerId: string | null): void {
    if (typeof (this.sttProvider as any).setManualTeacher === 'function') {
      (this.sttProvider as any).setManualTeacher(speakerId);
    }
  }

  private setState(newState: ProcessingState): void {
    if (this._state === newState) return;
    this._state = newState;
    console.log(`[ProcessingLayer] State changed: -> ${newState}`);
    this.emit('stateChange', newState);
    this.emit('statusUpdate', this.getStatus());
  }

  private setupListeners(): void {
    // 1. Attach STT to screening engine & setup STT listeners
    this.screeningEngine.attachSTT(this.sttProvider);
    this.setupSTTListeners();

    // 2. Setup STT listeners
    this.setupSTTListeners();

    // 3. Listen for LLM Screening Alerts -> trigger Action Layer notification
    this.screeningEngine.on('alert', async (verdict: ScreeningVerdict) => {
      console.log('[ProcessingLayer] 🔔 Screening condition triggered by LLM:', verdict.summary);
      this.lastNotificationInfo = {
        title: 'Skipper 课堂提醒',
        body: `【${verdict.reason}】\n${verdict.summary}`,
        reason: verdict.reason,
        summary: verdict.summary,
        timestamp: Date.now(),
      };

      await this.actionLayer.notify({
        title: '🔔 Skipper 课堂提醒',
        body: `【${verdict.reason}】\n${verdict.summary}`,
        reason: verdict.reason,
        summary: verdict.summary,
      });

      this.emit('screeningAlert', verdict);
      this.emit('statusUpdate', this.getStatus());
    });

    // 4. Forward LLM evaluation logs (for Debug panel & CLI)
    this.screeningEngine.on('evaluation', (log: EvaluationLog) => {
      this.emit('evaluationLog', log);
    });

    // 5. Pipe audio from input layer into STT provider
    const audioStream = this.inputLayer.getAudioStream();
    audioStream.on('data', (chunk: AudioChunk) => {
      if (this._state === 'monitoring') {
        this.audioChunksProcessedCount++;
        this.sttProvider.feedAudio(chunk.buffer);
      }
    });

    audioStream.on('level', (level: number) => {
      this.currentAudioLevel = level;
      this.emit('audioLevel', level);
    });

    // 6. When user confirms in browser window, auto-hide and auto-start monitoring
    this.inputLayer.on('initialized', async () => {
      console.log('[ProcessingLayer] Input layer confirmed initialized.');
      if (this.autoStartOnReady && this._state !== 'monitoring') {
        console.log('[ProcessingLayer] Auto-starting monitoring upon user confirmation...');
        try {
          await this.startMonitoring();
        } catch (err: any) {
          console.error('[ProcessingLayer] Failed to auto-start monitoring:', err?.message);
        }
      } else if (this._state === 'initializing' || this._state === 'idle') {
        this.setState('ready');
      }
    });
  }

  private setupSTTListeners(): void {
    this.sttProvider.on('segment', (segment: STTSegment) => {
      this.emit('transcriptSegment', segment);

      // Trigger 3-minute automatic teacher inference if applicable
      if (typeof (this.sttProvider as any).getTeacherResolver === 'function') {
        const resolver = (this.sttProvider as any).getTeacherResolver();
        const llmClient = this.screeningEngine.getLLMClient();
        if (llmClient) {
          resolver.maybeInferTeacherViaLLM(llmClient, segment.endTime).catch((err: any) => {
            console.warn('[ProcessingLayer] Automatic teacher resolution error:', err?.message || err);
          });
        }
      }
    });

    this.sttProvider.on('error', (err: Error) => {
      console.error('[ProcessingLayer] STT Provider error:', err.message);
      this.emit('error', err);
    });

    if (typeof (this.sttProvider as any).getTeacherResolver === 'function') {
      const resolver = (this.sttProvider as any).getTeacherResolver();
      resolver.on('tracksUpdated', (tracks: any) => {
        this.emit('speakerTracksUpdated', tracks);
      });
      resolver.on('teacherChanged', (newTeacherId: string, isManual: boolean, reason?: string) => {
        this.emit('teacherChanged', { teacherId: newTeacherId, isManual, reason });
      });
    }
  }

  public async initialize(url?: string): Promise<boolean> {
    this.setState('initializing');
    try {
      const ready = await this.inputLayer.initialize(url);
      if (ready) {
        if (this.autoStartOnReady) {
          await this.startMonitoring();
        } else {
          this.setState('ready');
        }
        return true;
      }
      this.setState('idle');
      return false;
    } catch (err) {
      console.error('[ProcessingLayer] Initialization error:', err);
      this.setState('error');
      throw err;
    }
  }

  public async startMonitoring(prompt?: string): Promise<void> {
    if (this._state === 'monitoring') {
      console.log('[ProcessingLayer] Already monitoring');
      return;
    }

    if (prompt) {
      this.setUserPrompt(prompt);
    }

    this.setState('monitoring');

    // Start STT provider
    if (!this.sttProvider.isRunning) {
      await this.sttProvider.start();
    }

    // Start audio stream
    await this.inputLayer.getAudioStream().start();

    // Start periodic screenshot capture (for manual inspection or future OCR)
    this.startFrameCaptureLoop();
  }

  public pauseMonitoring(): void {
    if (this._state !== 'monitoring') return;

    this.stopFrameCaptureLoop();
    this.inputLayer.getAudioStream().pause();
    this.setState('paused');
  }

  public resumeMonitoring(): void {
    if (this._state !== 'paused') return;

    this.setState('monitoring');
    this.inputLayer.getAudioStream().resume();
    this.startFrameCaptureLoop();
  }

  public async stopMonitoring(): Promise<void> {
    this.stopFrameCaptureLoop();
    await this.inputLayer.getAudioStream().stop();

    if (this.sttProvider.isRunning) {
      await this.sttProvider.stop();
    }

    this.setState(this.inputLayer.isInitialized ? 'ready' : 'idle');
  }

  public setUserPrompt(prompt: string): void {
    this.userPrompt = prompt;
    this.screeningEngine.setUserGoals([{ id: 'custom_1', text: prompt, enabled: true }]);
    console.log(`[ProcessingLayer] User condition prompt set to: "${prompt}"`);
    this.emit('statusUpdate', this.getStatus());
  }

  public getUserPrompt(): string {
    return this.userPrompt;
  }

  public setFrameInterval(intervalMs: number): void {
    this.frameIntervalMs = Math.max(1000, intervalMs);
    console.log(`[ProcessingLayer] Frame capture interval set to ${this.frameIntervalMs}ms`);
    if (this._state === 'monitoring') {
      this.stopFrameCaptureLoop();
      this.startFrameCaptureLoop();
    }
  }

  public async captureSingleFrame(): Promise<FrameData | null> {
    if (!this.inputLayer.isBrowserOpen) return null;
    try {
      const frame = await this.inputLayer.getCurrentFrame({ quality: 80, format: 'jpeg' });
      this.emit('frameProcessed', frame);
      return frame;
    } catch (err) {
      console.error('[ProcessingLayer] Failed to capture single frame:', err);
      return null;
    }
  }

  public async testNotification(
    reason: string = '测试通知',
    summary: string = '这是一条测试弹窗提醒：Skipper 运行正常！'
  ): Promise<boolean> {
    return await this.actionLayer.notify(reason, summary);
  }

  private startFrameCaptureLoop(): void {
    this.stopFrameCaptureLoop();
    this.captureAndProcessFrame();
    this.frameTimer = setInterval(() => {
      this.captureAndProcessFrame();
    }, this.frameIntervalMs);
  }

  private stopFrameCaptureLoop(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  private async captureAndProcessFrame(): Promise<void> {
    if (this.isCapturing || this._state !== 'monitoring') return;
    this.isCapturing = true;
    try {
      if (this.inputLayer.isBrowserOpen) {
        const frame = await this.inputLayer.getCurrentFrame({ quality: 75, format: 'jpeg' });
        this.framesProcessedCount++;
        this.emit('frameProcessed', frame);
      }
    } catch (err: any) {
      // Ignored if window temporarily unavailable
    } finally {
      this.isCapturing = false;
    }
  }

  public getStatus(): SkipperStatus {
    return {
      state: this._state,
      isInitialized: this.inputLayer.isInitialized,
      isBrowserOpen: this.inputLayer.isBrowserOpen,
      isAiConnected: this.sttProvider.isRunning,
      framesProcessed: this.framesProcessedCount,
      audioChunksProcessed: this.audioChunksProcessedCount,
      audioLevel: this.currentAudioLevel,
      currentCondition: this.userPrompt,
      lastNotification: this.lastNotificationInfo,
      lastActiveTimestamp: Date.now(),
    };
  }

  public onStateChange(handler: (state: ProcessingState) => void): void {
    this.on('stateChange', handler);
  }

  public onStatusUpdate(handler: (status: SkipperStatus) => void): void {
    this.on('statusUpdate', handler);
  }

  public onFrameProcessed(handler: (frame: FrameData) => void): void {
    this.on('frameProcessed', handler);
  }
}
