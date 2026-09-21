import { EventEmitter } from 'events';
import { session, app } from 'electron';
import { IInputLayer, InputLayerOptions, CaptureFrameOptions, IAudioStreamSource } from './types';
import { LiveBrowserWindow } from './browserWindow';
import { AudioStreamSource } from './audioStream';
import { FrameData } from '../../common/types';

export class InputLayer extends EventEmitter implements IInputLayer {
  private browser: LiveBrowserWindow;
  private audioStream: AudioStreamSource;
  private _isInitialized: boolean = false;
  private partition: string;
  private defaultUrl: string;
  private muteLocalPlayback: boolean = true;
  private initPromiseResolver: ((value: boolean) => void) | null = null;

  constructor(options: InputLayerOptions = {}) {
    super();
    this.partition = options.partition || 'persist:skipper-school';
    this.defaultUrl = options.defaultUrl || '';
    this.muteLocalPlayback = options.muteLocalPlayback !== undefined ? options.muteLocalPlayback : true;

    this.audioStream = new AudioStreamSource();

    this.browser = new LiveBrowserWindow(this.partition, {
      onInitializationRequested: () => {
        this.completeInitialization();
      },
      onClosed: () => {
        this.emit('browserClosed');
      },
      onUrlChanged: (url: string) => {
        this.emit('urlChanged', url);
      },
    });

    this.browser.setAudioMuted(this.muteLocalPlayback);

    this.setupDisplayMediaHandler();
  }

  public get isInitialized(): boolean {
    return this._isInitialized;
  }

  public get isBrowserOpen(): boolean {
    return this.browser.isOpen;
  }

  public getLiveBrowser(): LiveBrowserWindow {
    return this.browser;
  }

  public setMuteLocalPlayback(muted: boolean): void {
    this.muteLocalPlayback = muted;
    this.browser.setAudioMuted(muted);
    console.log(`[InputLayer] Local audio playback muting set to: ${muted}`);
  }

  public getMuteLocalPlayback(): boolean {
    return this.muteLocalPlayback;
  }

  public async flushStorage(): Promise<void> {
    await this.browser.flushStorage();
  }

  /**
   * Configure Electron's setDisplayMediaRequestHandler to isolate the live stream audio
   * and conditionally mute or enable local speaker playback based on muteLocalPlayback setting.
   */
  private setupDisplayMediaHandler(): void {
    const ses = session.fromPartition(this.partition);

    const handler = (request: any, callback: (options: any) => void) => {
      const mainFrame = this.browser.getMainFrame();
      console.log(
        `[InputLayer] Handling setDisplayMediaRequest. MainFrame available: ${!!mainFrame}, muteLocalPlayback: ${this.muteLocalPlayback}`
      );

      if (mainFrame) {
        callback({
          video: mainFrame,
          audio: mainFrame,
          // Enable local echo so live window audio plays to speakers when unmuted.
          // Physical speaker playback is muted or unmuted directly via LiveBrowserWindow webContents.setAudioMuted(muted).
          enableLocalEcho: true,
        });
      } else {
        callback({});
      }
    };

    ses.setDisplayMediaRequestHandler(handler);
    // Also attach to defaultSession in case the capturer runs in default session
    session.defaultSession.setDisplayMediaRequestHandler(handler);
  }

  /**
   * Initializes the input layer:
   * 1. Opens the built-in browser window (visible to the user).
   * 2. User operates directly (logs in, opens courseware, starts video playback).
   * 3. Waits until user triggers initialization completion (via UI button/interaction).
   */
  public async initialize(initialUrl?: string): Promise<boolean> {
    console.log('[InputLayer] Starting initialization: opening live browser window...');
    const url = initialUrl || this.defaultUrl;

    const promise = new Promise<boolean>((resolve) => {
      this.initPromiseResolver = resolve;
      this.emit('initializing');
    });

    await this.browser.create(url);

    if (this._isInitialized) {
      return true;
    }

    return promise;
  }

  /**
   * Signal that user has completed browser interaction (login + video playing)
   */
  public completeInitialization(): void {
    if (this._isInitialized) return;

    this._isInitialized = true;
    console.log('[InputLayer] Initialization completed by user interaction');
    this.emit('initialized');

    if (this.initPromiseResolver) {
      this.initPromiseResolver(true);
      this.initPromiseResolver = null;
    }
  }

  /**
   * Reset initialization state (e.g. if user wants to change classroom or re-login)
   */
  public resetInitialization(): void {
    this._isInitialized = false;
    this.emit('reset');
  }

  /**
   * Captures the current moment's image from the live browser webContents.
   */
  public async getCurrentFrame(options?: CaptureFrameOptions): Promise<FrameData> {
    if (!this.browser.isOpen) {
      throw new Error('InputLayer: Browser window is not open. Please call initialize() or openBrowser() first.');
    }
    return await this.browser.captureCurrentFrame(options);
  }

  /**
   * Gets the audio stream interface
   */
  public getAudioStream(): IAudioStreamSource {
    return this.audioStream;
  }

  /**
   * Pass raw audio chunk to internal audio stream (received via IPC from capturer)
   */
  public pushAudioChunk(rawBuffer: Buffer | Uint8Array | ArrayBuffer, level?: number): void {
    this.audioStream.pushChunk(rawBuffer, level);
  }

  public async openBrowser(url?: string): Promise<void> {
    await this.browser.create(url || this.defaultUrl);
  }

  public hideBrowser(): void {
    this.browser.hide();
  }

  public showBrowser(): void {
    this.browser.show();
  }

  public async destroy(): Promise<void> {
    await this.audioStream.stop();
    this.browser.destroy();
    this._isInitialized = false;
  }
}
