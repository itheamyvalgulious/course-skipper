import { BrowserWindow, Menu, app, dialog, NativeImage } from 'electron';
import * as path from 'path';
import { FrameData } from '../../common/types';
import { CaptureFrameOptions } from './types';

export interface LiveBrowserWindowEvents {
  onInitializationRequested?: () => void;
  onClosed?: () => void;
  onUrlChanged?: (url: string) => void;
}

export class LiveBrowserWindow {
  private window: BrowserWindow | null = null;
  private partition: string;
  private events: LiveBrowserWindowEvents;
  private currentUrl: string = '';
  private isAudioMuted: boolean = false;

  constructor(partition: string = 'persist:skipper-school', events: LiveBrowserWindowEvents = {}) {
    this.partition = partition;
    this.events = events;
  }

  public get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  public getWebContents() {
    return this.window ? this.window.webContents : null;
  }

  public getMainFrame() {
    return this.window && !this.window.isDestroyed() ? this.window.webContents.mainFrame : null;
  }

  public getSession() {
    return this.window ? this.window.webContents.session : null;
  }

  public getUrl(): string {
    if (this.isOpen && this.window) {
      return this.window.webContents.getURL();
    }
    return this.currentUrl;
  }

  /**
   * Flush cookies and session storage data to disk immediately
   */
  public async flushStorage(): Promise<void> {
    try {
      if (this.window && !this.window.isDestroyed()) {
        const ses = this.window.webContents.session;
        if (ses) {
          await ses.flushStorageData();
          await ses.cookies.flushStore();
        }
      }
    } catch (err: any) {
      console.warn('[LiveBrowserWindow] Failed to flush storage:', err?.message);
    }
  }

  /**
   * Control direct audio muting on the webContents
   */
  public setAudioMuted(muted: boolean): void {
    this.isAudioMuted = muted;
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.setAudioMuted(muted);
    }
  }

  public getAudioMuted(): boolean {
    return this.isAudioMuted;
  }

  /**
   * Create and show the live browser window
   */
  public async create(initialUrl?: string): Promise<BrowserWindow> {
    if (this.isOpen && this.window) {
      this.window.show();
      this.window.focus();
      if (initialUrl && initialUrl !== this.getUrl()) {
        await this.navigate(initialUrl);
      }
      return this.window;
    }

    const targetUrl = initialUrl || 'about:blank';
    this.currentUrl = targetUrl;

    this.window = new BrowserWindow({
      width: 1200,
      height: 800,
      backgroundColor: '#0f172a',
      title: 'Skipper - 课堂直播内置浏览器 (请登录并播放视频)',
      autoHideMenuBar: false,
      webPreferences: {
        partition: this.partition,
        // CRITICAL: Disable background throttling so video and audio keep running in background!
        backgroundThrottling: false,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });

    this.window.webContents.setAudioMuted(this.isAudioMuted);

    this.setupWindowMenu();

    // INTERCEPT POPUP WINDOWS: Always load links in the same LiveBrowserWindow
    this.window.webContents.setWindowOpenHandler((details) => {
      const url = details.url;
      console.log('[LiveBrowserWindow] Intercepted popup window request. Redirecting in same window to:', url);
      if (url && url !== 'about:blank') {
        setImmediate(() => {
          if (this.isOpen && this.window) {
            this.window.loadURL(url);
          }
        });
      }
      return { action: 'deny' };
    });

    // Track URL changes and persist session/cookies on navigation
    this.window.webContents.on('did-navigate', (_event, url) => {
      this.currentUrl = url;
      this.flushStorage();
      if (this.events.onUrlChanged && url && !url.startsWith('about:')) {
        this.events.onUrlChanged(url);
      }
    });

    this.window.webContents.on('did-navigate-in-page', (_event, url) => {
      this.currentUrl = url;
      this.flushStorage();
      if (this.events.onUrlChanged && url && !url.startsWith('about:')) {
        this.events.onUrlChanged(url);
      }
    });

    this.window.webContents.on('console-message', (_event, _level, message) => {
      if (typeof message === 'string' && message.includes('__SKIPPER_CONFIRM_PLAY__')) {
        console.log('[LiveBrowserWindow] User confirmed playback in live window. Auto-hiding and completing initialization...');
        this.hide();
        if (this.events.onInitializationRequested) {
          this.events.onInitializationRequested();
        }
      }
    });

    this.window.on('closed', () => {
      this.flushStorage();
      this.window = null;
      if (this.events.onClosed) {
        this.events.onClosed();
      }
    });

    // When page finishes loading or DOM is ready, inject guards and floating status banner
    this.window.webContents.on('dom-ready', () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.setAudioMuted(this.isAudioMuted);
      }
      this.injectSameWindowGuards();
      this.injectFloatingBar();
    });

    this.window.webContents.on('did-finish-load', () => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.setAudioMuted(this.isAudioMuted);
      }
      this.flushStorage();
      this.injectSameWindowGuards();
      this.injectFloatingBar();
    });

    await this.window.loadURL(targetUrl);
    return this.window;
  }

  public async navigate(url: string): Promise<void> {
    if (!this.isOpen || !this.window) {
      await this.create(url);
      return;
    }
    this.currentUrl = url;
    await this.window.loadURL(url);
  }

  public show(): void {
    if (this.isOpen && this.window) {
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.focus();
    }
  }

  public hide(): void {
    if (this.isOpen && this.window) {
      this.window.hide();
    }
  }

  public destroy(): void {
    if (this.isOpen && this.window) {
      this.window.destroy();
      this.window = null;
    }
  }

  /**
   * Capture the current frame from the live webContents
   */
  public async captureCurrentFrame(options?: CaptureFrameOptions): Promise<FrameData> {
    if (!this.isOpen || !this.window) {
      throw new Error('Cannot capture frame: Live browser window is not open');
    }

    const format = options?.format || 'jpeg';
    const quality = options?.quality ?? 80;

    const nativeImg: NativeImage = await this.window.webContents.capturePage();
    const size = nativeImg.getSize();

    let buffer: Buffer;
    let mimeType: string;

    if (format === 'png') {
      buffer = nativeImg.toPNG();
      mimeType = 'image/png';
    } else {
      buffer = nativeImg.toJPEG(quality);
      mimeType = 'image/jpeg';
    }

    const dataUrl = nativeImg.toDataURL();

    return {
      buffer,
      mimeType,
      width: size.width,
      height: size.height,
      timestamp: Date.now(),
      dataUrl,
    };
  }

  /**
   * Setup a clean application menu for the browser window
   */
  private setupWindowMenu(): void {
    if (!this.window) return;

    const menu = Menu.buildFromTemplate([
      {
        label: '🚀 初始化操作',
        submenu: [
          {
            label: '✅ 完成初始化 (开始/准备监控)',
            accelerator: 'CmdOrCtrl+Enter',
            click: () => {
              if (this.events.onInitializationRequested) {
                this.events.onInitializationRequested();
              }
            },
          },
          {
            label: '⬅️ 后退 (Back)',
            accelerator: 'Alt+Left',
            click: () => {
              if (this.window?.webContents.canGoBack()) {
                this.window.webContents.goBack();
              }
            },
          },
          {
            label: '➡️ 前进 (Forward)',
            accelerator: 'Alt+Right',
            click: () => {
              if (this.window?.webContents.canGoForward()) {
                this.window.webContents.goForward();
              }
            },
          },
          {
            label: '🔄 刷新页面',
            accelerator: 'CmdOrCtrl+R',
            click: () => {
              this.window?.webContents.reload();
            },
          },
        ],
      },
      {
        label: '视图',
        submenu: [
          {
            label: '隐藏到后台 (继续监控)',
            accelerator: 'CmdOrCtrl+H',
            click: () => this.hide(),
          },
          {
            label: '开发者工具 (直播页面)',
            accelerator: 'CmdOrCtrl+Shift+I',
            click: () => {
              this.window?.webContents.openDevTools({ mode: 'detach' });
            },
          },
        ],
      },
    ]);

    this.window.setMenu(menu);
  }

  /**
   * Guard against popup windows and force links to open in the current window
   */
  private injectSameWindowGuards(): void {
    if (!this.window || this.window.isDestroyed()) return;

    const script = `
      (function() {
        if (window.__skipper_same_window_guard_injected) return;
        window.__skipper_same_window_guard_injected = true;

        // Override window.open to navigate in the current frame
        const origOpen = window.open;
        window.open = function(url, target, features) {
          if (url && typeof url === 'string' && url.length > 0 && url !== 'about:blank') {
            window.location.href = url;
          }
          return null;
        };

        // Intercept target="_blank" link clicks
        document.addEventListener('click', function(e) {
          const a = e.target && (e.target.closest ? e.target.closest('a') : null);
          if (a && a.tagName === 'A') {
            if (a.target === '_blank' || a.getAttribute('target') === '_blank') {
              a.target = '_self';
            }
          }
        }, true);
      })();
    `;

    this.window.webContents.executeJavaScript(script).catch(() => {});
  }

  /**
   * Inject a floating interactive banner into the live page
   */
  private injectFloatingBar(): void {
    if (!this.window || this.window.isDestroyed()) return;

    const script = `
      (function() {
        if (document.getElementById('skipper-floating-toolbar')) return;
        const banner = document.createElement('div');
        banner.id = 'skipper-floating-toolbar';
        banner.style.cssText = 'position:fixed;top:12px;right:16px;z-index:2147483647;background:rgba(24,24,27,0.92);color:#fff;padding:8px 14px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:13px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.15);user-select:none;';
        
        const text = document.createElement('span');
        text.innerText = 'Skipper: 登录并开始播放视频后点击 ->';
        text.style.color = '#e4e4e7';

        const btn = document.createElement('button');
        btn.innerText = '✅ 确认播放';
        btn.style.cssText = 'background:#22c55e;color:#000;border:none;padding:5px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;transition:all 0.2s;';
        btn.onmouseover = () => btn.style.background = '#16a34a';
        btn.onmouseout = () => btn.style.background = '#22c55e';
        btn.onclick = () => {
          btn.innerText = '✓ 正在监控 (窗口已隐藏)';
          btn.disabled = true;
          btn.style.background = '#4b5563';
          btn.style.color = '#9ca3af';
          text.innerText = 'Skipper: 监控中 (已置入后台运行)';
          console.log('__SKIPPER_CONFIRM_PLAY__');
          window.postMessage({ type: 'SKIPPER_INIT_CLICK' }, '*');
        };

        banner.appendChild(text);
        banner.appendChild(btn);
        document.body.appendChild(banner);
      })();
    `;

    this.window.webContents.executeJavaScript(script).catch(() => {
      // Ignored if CSP restricts injection
    });
  }
}
