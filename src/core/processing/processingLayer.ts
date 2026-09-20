import { EventEmitter } from 'events';
import { IInputLayer } from '../input/types';
import { IActionLayer } from '../action/types';
import { IAIProvider, NotificationTrigger } from '../provider/types';
import { IProcessingLayer, ProcessingOptions } from './types';
import { ProcessingState, SkipperStatus, FrameData, AudioChunk } from '../../common/types';

export class ProcessingLayer extends EventEmitter implements IProcessingLayer {
  private inputLayer: IInputLayer;
  private actionLayer: IActionLayer;
  private provider: IAIProvider;

  private _state: ProcessingState = 'idle';
  private frameIntervalMs: number = 2500;
  private heartbeatIntervalMs: number = 10000; // 10s heartbeat evaluation
  private frameTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isCapturing: boolean = false;

  private userPrompt: string = '当老师讲完当前知识点或证明时叫我';
  private framesProcessedCount: number = 0;
  private audioChunksProcessedCount: number = 0;
  private currentAudioLevel: number = 0;
  private lastNotificationInfo?: SkipperStatus['lastNotification'];

  constructor(
    inputLayer: IInputLayer,
    actionLayer: IActionLayer,
    provider: IAIProvider,
    options: ProcessingOptions = {}
  ) {
    super();
    this.inputLayer = inputLayer;
    this.actionLayer = actionLayer;
    this.provider = provider;

    if (options.frameIntervalMs) {
      this.frameIntervalMs = options.frameIntervalMs;
    }

    this.setupListeners();
  }

  public get state(): ProcessingState {
    return this._state;
  }

  private setState(newState: ProcessingState): void {
    if (this._state === newState) return;
    this._state = newState;
    console.log(`[ProcessingLayer] State changed: -> ${newState}`);
    this.emit('stateChange', newState);
    this.emit('statusUpdate', this.getStatus());
  }

  private setupListeners(): void {
    // 1. Listen for AI Provider notification triggers -> dispatch to Action Layer
    this.provider.onNotificationTrigger(async (trigger: NotificationTrigger) => {
      console.log('[ProcessingLayer] Received notification trigger from Provider:', trigger);
      this.lastNotificationInfo = {
        title: 'Skipper 课堂提醒',
        body: `【${trigger.reason}】\n${trigger.summary}`,
        reason: trigger.reason,
        summary: trigger.summary,
        timestamp: trigger.timestamp,
      };

      await this.actionLayer.notify({
        title: '🔔 Skipper 课堂提醒',
        body: `【${trigger.reason}】\n${trigger.summary}`,
        reason: trigger.reason,
        summary: trigger.summary,
      });

      this.emit('statusUpdate', this.getStatus());
    });

    // 2. Listen to Audio Stream events from Input Layer -> pipe to Provider
    const audioStream = this.inputLayer.getAudioStream();
    audioStream.on('data', (chunk: AudioChunk) => {
      if (this._state === 'monitoring') {
        this.audioChunksProcessedCount++;
        this.provider.sendAudioChunk(chunk.buffer).catch((err) => {
          console.error('[ProcessingLayer] Error piping audio to provider:', err);
        });
      }
    });

    audioStream.on('level', (level: number) => {
      this.currentAudioLevel = level;
      this.emit('audioLevel', level);
    });

    // 3. Listen to input layer events
    this.inputLayer.on('initialized', () => {
      if (this._state === 'initializing' || this._state === 'idle') {
        this.setState('ready');
      }
    });
  }

  /**
   * Initializes the pipeline:
   * Opens live browser for user to log in and play video,
   * then completes initialization on user confirmation.
   */
  public async initialize(url?: string): Promise<boolean> {
    this.setState('initializing');
    try {
      const ready = await this.inputLayer.initialize(url);
      if (ready) {
        this.setState('ready');
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

  /**
   * Start monitoring classroom live stream
   */
  public async startMonitoring(prompt?: string): Promise<void> {
    if (this._state === 'monitoring') {
      console.log('[ProcessingLayer] Already monitoring');
      return;
    }

    if (!this.inputLayer.isInitialized) {
      throw new Error('Cannot start monitoring: Input layer is not initialized. Please complete browser setup first.');
    }

    if (prompt) {
      this.setUserPrompt(prompt);
    }

    this.setState('monitoring');

    // Connect provider if not connected
    if (!this.provider.isConnected) {
      await this.provider.connect();
    }
    this.provider.setUserPrompt(this.userPrompt);

    // Start audio stream
    await this.inputLayer.getAudioStream().start();

    // Start periodic screenshot capture
    this.startFrameCaptureLoop();

    // Start 10-second heartbeat reasoning evaluation loop
    this.startHeartbeatLoop();
  }

  /**
   * Pause monitoring (temporarily halt screenshots, heartbeat and audio piping)
   */
  public pauseMonitoring(): void {
    if (this._state !== 'monitoring') return;

    this.stopFrameCaptureLoop();
    this.stopHeartbeatLoop();
    this.inputLayer.getAudioStream().pause();
    this.setState('paused');
  }

  /**
   * Resume monitoring
   */
  public resumeMonitoring(): void {
    if (this._state !== 'paused') return;

    this.setState('monitoring');
    this.inputLayer.getAudioStream().resume();
    this.startFrameCaptureLoop();
    this.startHeartbeatLoop();
  }

  /**
   * Stop monitoring completely
   */
  public async stopMonitoring(): Promise<void> {
    this.stopFrameCaptureLoop();
    this.stopHeartbeatLoop();
    await this.inputLayer.getAudioStream().stop();

    if (this.provider.isConnected) {
      await this.provider.disconnect();
    }

    this.setState(this.inputLayer.isInitialized ? 'ready' : 'idle');
  }

  public setUserPrompt(prompt: string): void {
    this.userPrompt = prompt;
    this.provider.setUserPrompt(prompt);
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

  /**
   * Capture a single frame right now (for testing or manual inspection)
   */
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

  /**
   * Test the action layer notification directly
   */
  public async testNotification(
    reason: string = '测试通知',
    summary: string = '这是一条测试弹窗提醒：Skipper 运行正常！'
  ): Promise<boolean> {
    return await this.actionLayer.notify(reason, summary);
  }

  private startFrameCaptureLoop(): void {
    this.stopFrameCaptureLoop();

    // Trigger an immediate frame capture
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

  private startHeartbeatLoop(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this._state === 'monitoring' && this.provider.isConnected) {
        if (this.provider.sendHeartbeat) {
          this.provider.sendHeartbeat().catch((err) => {
            console.error('[ProcessingLayer] Error in periodic heartbeat evaluation:', err?.message);
          });
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async captureAndProcessFrame(): Promise<void> {
    if (this._state !== 'monitoring' || this.isCapturing) return;

    this.isCapturing = true;
    try {
      const frame = await this.inputLayer.getCurrentFrame({ quality: 80, format: 'jpeg' });
      this.framesProcessedCount++;

      // Send frame to AI Provider
      await this.provider.sendFrame(frame.buffer, frame.mimeType);

      // Notify dashboard for live preview
      this.emit('frameProcessed', frame);
    } catch (err) {
      console.error('[ProcessingLayer] Error capturing or processing frame:', err);
    } finally {
      this.isCapturing = false;
    }
  }

  public getStatus(): SkipperStatus {
    return {
      state: this._state,
      browserUrl: (this.inputLayer as any).getLiveBrowser?.().getUrl() || '',
      isBrowserOpen: this.inputLayer.isBrowserOpen,
      isInitialized: this.inputLayer.isInitialized,
      isAudioActive: this.inputLayer.getAudioStream().isStreaming,
      audioLevel: this.currentAudioLevel,
      userPrompt: this.userPrompt,
      framesProcessed: this.framesProcessedCount,
      audioChunksProcessed: this.audioChunksProcessedCount,
      lastNotification: this.lastNotificationInfo,
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
