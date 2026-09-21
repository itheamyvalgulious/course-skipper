import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { execSync } from 'child_process';
import { InputLayer } from '../core/input/inputLayer';
import { ActionLayer } from '../core/action/actionLayer';
import { createSTTProvider, ISTTProvider } from '../core/stt';
import { ScreeningEngine, LLMClient } from '../core/llm';
import { ProcessingLayer } from '../core/processing/processingLayer';
import { ConfigStore } from '../core/config/configStore';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
} from '../core/config/constants';
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
let sttProvider: ISTTProvider | null = null;
let screeningEngine: ScreeningEngine | null = null;
let processingLayer: ProcessingLayer | null = null;
let configStore: ConfigStore | null = null;

async function createDashboardWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1040,
    height: 860,
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

  // 1. Initialize Config Store
  configStore = new ConfigStore();
  const savedConfig = configStore.getConfig();
  console.log('[Skipper] Loaded persistent config from disk. STT Provider:', savedConfig.stt?.provider || 'cpu');

  // 2. Initialize Input Layer with persistent session partition, last URL and silent audio setting
  inputLayer = new InputLayer({
    partition: 'persist:skipper-school',
    defaultUrl: savedConfig.lastBrowserUrl || '',
    muteLocalPlayback: savedConfig.muteLocalAudio ?? true,
  });

  // 3. Initialize Action Layer
  actionLayer = new ActionLayer();

  // 4. Initialize STT Provider (Google Cloud STT or Local CPU STT)
  const sttConfig = savedConfig.stt || { provider: 'cpu', languageCode: 'zh-CN', rollingWindowSec: 30 };
  sttProvider = createSTTProvider({
    provider: sttConfig.provider || 'cpu',
    googleApiKey: sttConfig.googleApiKey,
    googleLanguageCode: sttConfig.languageCode || 'zh-CN',
    rollingWindowSec: sttConfig.rollingWindowSec || 30,
  });

  // 5. Initialize LLM Client & Screening Engine
  const llmConfig = savedConfig.llm || {
    baseUrl: DEFAULT_LLM_BASE_URL,
    apiKey: DEFAULT_LLM_API_KEY,
    model: DEFAULT_LLM_MODEL,
    maxContextTokens: 8192,
    compactRatio: 0.60,
  };

  const llmClient = new LLMClient({
    baseUrl: llmConfig.baseUrl,
    apiKey: llmConfig.apiKey,
    defaultModel: llmConfig.model,
  });

  screeningEngine = new ScreeningEngine({
    llmClient,
    goals: savedConfig.goals,
    goalLogic: savedConfig.goalLogic,
    systemPrompt: savedConfig.prompts?.systemPrompt,
    compactPrompt: savedConfig.prompts?.compactPrompt,
    thresholds: savedConfig.thresholds,
    maxContextTokens: llmConfig.maxContextTokens,
    compactThresholdRatio: llmConfig.compactRatio,
  });

  // 6. Initialize Processing Layer (Scheduler / Coordinator)
  processingLayer = new ProcessingLayer(inputLayer, actionLayer, sttProvider, screeningEngine, {
    frameIntervalMs: 2500,
    autoStartOnReady: true,
  });

  // 7. Create Dashboard Window
  dashboardWindow = await createDashboardWindow();

  // 8. Setup IPC handlers
  setupIpcHandlers(
    inputLayer,
    processingLayer,
    actionLayer,
    sttProvider,
    screeningEngine,
    configStore,
    () => dashboardWindow
  );

  console.log('[Skipper] Skipper modules ready and IPC handlers registered.');

  // 9. Open live browser window (restores last lecture URL if available)
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
});
