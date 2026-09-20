import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { execSync } from 'child_process';
import { InputLayer } from '../core/input/inputLayer';
import { ActionLayer } from '../core/action/actionLayer';
import { GeminiLiveProvider } from '../core/provider/geminiLiveProvider';
import { ProcessingLayer } from '../core/processing/processingLayer';
import { GeminiLiveMockServer } from '../mock/geminiLiveMockServer';
import { ConfigStore } from '../core/config/configStore';
import { setupIpcHandlers } from './ipc';

// Ensure UTF-8 code page on Windows console to prevent mojibake
if (process.platform === 'win32') {
  try {
    execSync('chcp 65001 >nul 2>&1');
  } catch {}
}

// Command line switches for smooth media capture (GPU hardware acceleration remains fully enabled)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-user-gesture-requirement-for-presentation');

let dashboardWindow: BrowserWindow | null = null;
let inputLayer: InputLayer | null = null;
let actionLayer: ActionLayer | null = null;
let geminiProvider: GeminiLiveProvider | null = null;
let processingLayer: ProcessingLayer | null = null;
let mockServer: GeminiLiveMockServer | null = null;
let configStore: ConfigStore | null = null;

async function createDashboardWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 980,
    height: 840,
    backgroundColor: '#090d16',
    title: 'Skipper - 听课助手控制中心',
    webPreferences: {
      preload: path.join(__dirname, '../preload/dashboard.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  const dashboardHtml = path.join(__dirname, '../renderer/dashboard/index.html');
  win.loadFile(dashboardHtml);

  win.on('closed', () => {
    dashboardWindow = null;
    app.quit();
  });

  return win;
}

app.whenReady().then(async () => {
  console.log('[Skipper] Initializing Skipper modules with persistent storage...');

  // Initialize Config Store
  configStore = new ConfigStore();
  const savedConfig = configStore.getConfig();
  console.log('[Skipper] Loaded persistent config from disk. Backend:', savedConfig.backendType);

  // Start background Gemini Live Mock Server (for offline testing or mock mode)
  try {
    mockServer = new GeminiLiveMockServer({
      port: 8089,
      proactiveIntervalMs: 10000,
      usageIntervalMs: 10000,
      logLevel: 'info',
    });
    await mockServer.start();
    console.log('[Skipper] Background Gemini Live Mock Server running on ws://127.0.0.1:8089');
  } catch (err: any) {
    console.warn('[Skipper] Could not start background mock server (may already be in use):', err.message);
  }

  // 1. Initialize Input Layer with persistent session partition, last URL and silent audio setting
  inputLayer = new InputLayer({
    partition: 'persist:skipper-school',
    defaultUrl: savedConfig.lastBrowserUrl || '',
    muteLocalPlayback: savedConfig.muteLocalAudio ?? true,
  });

  // 2. Initialize Action Layer
  actionLayer = new ActionLayer();

  // 3. Initialize Gemini Live Provider with persistent config or environment fallbacks
  const apiKey = savedConfig.apiKey || process.env.GEMINI_API_KEY || '';
  const vertexProject = savedConfig.vertexProject || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
  const vertexLocation = savedConfig.vertexLocation || process.env.GOOGLE_CLOUD_LOCATION || process.env.GCP_LOCATION || 'us-central1';

  geminiProvider = new GeminiLiveProvider({
    apiKey,
    model: savedConfig.model || 'gemini-3.8-live',
    backendType: savedConfig.backendType || 'mock',
    vertexProject,
    vertexLocation,
    userPrompt: savedConfig.userPrompt || '当老师讲完当前知识点或证明时叫我',
    endpoint: 'ws://127.0.0.1:8089',
  });

  // 4. Initialize Processing Layer (Scheduler / Coordinator)
  processingLayer = new ProcessingLayer(inputLayer, actionLayer, geminiProvider, {
    frameIntervalMs: 2500, // 2.5s periodic sparse frame capture as designed
  });

  // 5. Create Dashboard Window
  dashboardWindow = await createDashboardWindow();

  // 6. Setup IPC handlers
  setupIpcHandlers(
    inputLayer,
    processingLayer,
    actionLayer,
    geminiProvider,
    configStore,
    () => dashboardWindow
  );

  console.log('[Skipper] Skipper modules ready and IPC handlers registered.');

  // 7. Open live browser window (automatically restores last lecture URL if available)
  const initialUrl = savedConfig.lastBrowserUrl || undefined;
  inputLayer.openBrowser(initialUrl).then(() => {
    if (inputLayer && actionLayer) {
      actionLayer.setTargetFocusWindow((inputLayer.getLiveBrowser() as any).window);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (processingLayer) {
    await processingLayer.stopMonitoring();
  }
  if (inputLayer) {
    await inputLayer.flushStorage();
    await inputLayer.destroy();
  }
  if (configStore) {
    configStore.saveConfig();
  }
  if (mockServer) {
    await mockServer.stop();
  }
});

