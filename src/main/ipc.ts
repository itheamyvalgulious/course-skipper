import { ipcMain, BrowserWindow } from 'electron';
import { InputLayer } from '../core/input/inputLayer';
import { ProcessingLayer } from '../core/processing/processingLayer';
import { ActionLayer } from '../core/action/actionLayer';
import { IAIProvider } from '../core/provider/types';
import { GeminiLiveProvider } from '../core/provider/geminiLiveProvider';
import { MockAIProvider } from '../core/provider/mockProvider';
import { FrameData } from '../common/types';
import { ConfigStore, SkipperConfig } from '../core/config/configStore';

export function setupIpcHandlers(
  inputLayer: InputLayer,
  processingLayer: ProcessingLayer,
  actionLayer: ActionLayer,
  provider: IAIProvider,
  configStore: ConfigStore,
  getDashboardWindow: () => BrowserWindow | null
): void {
  // Config handlers
  ipcMain.handle('skipper:get-config', async () => {
    return configStore.getConfig();
  });

  ipcMain.handle('skipper:set-mute-local', async (_e, muted: boolean) => {
    inputLayer.setMuteLocalPlayback(muted);
    configStore.updateConfig({ muteLocalAudio: muted });
    return true;
  });

  // Input layer handlers
  ipcMain.handle('skipper:open-browser', async (_e, url?: string) => {
    if (url && !url.startsWith('about:')) {
      configStore.updateConfig({ lastBrowserUrl: url });
    }
    await inputLayer.openBrowser(url);
    return true;
  });

  ipcMain.handle('skipper:hide-browser', async () => {
    inputLayer.hideBrowser();
    return true;
  });

  ipcMain.handle('skipper:show-browser', async () => {
    inputLayer.showBrowser();
    return true;
  });

  ipcMain.handle('skipper:complete-init', async () => {
    inputLayer.completeInitialization();
    return true;
  });

  ipcMain.handle('skipper:capture-frame', async () => {
    return await processingLayer.captureSingleFrame();
  });

  // Processing layer handlers
  ipcMain.handle('skipper:start-monitoring', async (_e, prompt?: string) => {
    if (prompt) {
      configStore.updateConfig({ userPrompt: prompt });
    }
    await processingLayer.startMonitoring(prompt);
    return true;
  });

  ipcMain.handle('skipper:pause-monitoring', async () => {
    processingLayer.pauseMonitoring();
    return true;
  });

  ipcMain.handle('skipper:resume-monitoring', async () => {
    processingLayer.resumeMonitoring();
    return true;
  });

  ipcMain.handle('skipper:stop-monitoring', async () => {
    await processingLayer.stopMonitoring();
    return true;
  });

  ipcMain.handle('skipper:set-prompt', async (_e, prompt: string) => {
    configStore.updateConfig({ userPrompt: prompt });
    processingLayer.setUserPrompt(prompt);
    return true;
  });

  ipcMain.handle('skipper:get-status', async () => {
    const status = processingLayer.getStatus();
    const providerInfo = (provider as any).getProviderInfo?.() || {
      name: provider.name,
      isConnected: provider.isConnected,
      apiKey: (provider as any).getApiKey?.() ? '******' : '',
      backendType: (provider as any).getBackendType?.() || ((provider as any).isUsingMockServer?.() ? 'mock' : 'aistudio'),
      useMockServer: (provider as any).isUsingMockServer?.() ?? true,
      stats: (provider as any).getStats?.() || {},
    };
    return {
      ...status,
      provider: providerInfo,
      config: configStore.getConfig(),
    };
  });

  // Gemini Live & Provider config handlers
  ipcMain.handle('skipper:set-api-key', async (_e, apiKey: string) => {
    configStore.updateConfig({ apiKey });
    if ((provider as any).setApiKey) {
      (provider as any).setApiKey(apiKey);
    }
    return true;
  });

  ipcMain.handle('skipper:set-provider-mode', async (_e, useMockServer: boolean, endpoint?: string) => {
    configStore.updateConfig({ backendType: useMockServer ? 'mock' : 'aistudio' });
    if ((provider as any).setUseMockServer) {
      (provider as any).setUseMockServer(useMockServer, endpoint);
    }
    return true;
  });

  ipcMain.handle('skipper:set-backend-type', async (_e, backendType: any) => {
    configStore.updateConfig({ backendType });
    if ((provider as any).setBackendType) {
      (provider as any).setBackendType(backendType);
    }
    return true;
  });

  ipcMain.handle('skipper:set-vertex-config', async (_e, project?: string, location?: string) => {
    configStore.updateConfig({ vertexProject: project, vertexLocation: location });
    if ((provider as any).setVertexConfig) {
      (provider as any).setVertexConfig(project, location);
    }
    return true;
  });

  ipcMain.handle('skipper:set-provider-config', async (_e, config: any) => {
    const update: Partial<SkipperConfig> = {};
    if (config.backendType) update.backendType = config.backendType;
    if (config.apiKey !== undefined) update.apiKey = config.apiKey;
    if (config.project !== undefined) update.vertexProject = config.project;
    if (config.location !== undefined) update.vertexLocation = config.location;
    if (config.model !== undefined) update.model = config.model;
    configStore.updateConfig(update);

    if ((provider as any).setProviderConfig) {
      (provider as any).setProviderConfig(config);
    }
    return true;
  });

  ipcMain.handle('skipper:set-model', async (_e, model: string) => {
    configStore.updateConfig({ model });
    if ((provider as any).setModel) {
      (provider as any).setModel(model);
    }
    return true;
  });

  // Action layer handlers
  ipcMain.handle('skipper:test-notification', async (_e, reason?: string, summary?: string) => {
    return await processingLayer.testNotification(reason, summary);
  });

  // Manual/mock trigger notification handler
  ipcMain.handle('skipper:mock-trigger-notification', async (_e, reason?: string, summary?: string) => {
    if (provider instanceof MockAIProvider) {
      provider.mockTriggerNotification(reason, summary);
    } else {
      (provider as any).triggerNotification?.(
        reason || '手动触发提醒',
        summary || '用户在控制台手动触发了提醒测试',
        '知识点总结'
      );
    }
    return true;
  });

  // Incoming audio chunk from capturer
  ipcMain.on('skipper:audio-chunk', (_e, rawBuffer: Buffer, level?: number) => {
    inputLayer.pushAudioChunk(rawBuffer, level);
  });

  // Forward core events to Dashboard Renderer
  const sendToDashboard = (channel: string, ...args: any[]) => {
    const win = getDashboardWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  };

  processingLayer.onStatusUpdate((status) => {
    sendToDashboard('skipper:status-update', status);
  });

  processingLayer.onFrameProcessed((frame: FrameData) => {
    sendToDashboard('skipper:frame-processed', {
      timestamp: frame.timestamp,
      width: frame.width,
      height: frame.height,
      mimeType: frame.mimeType,
      dataUrl: frame.dataUrl,
    });
  });

  processingLayer.on('audioLevel', (level: number) => {
    sendToDashboard('skipper:audio-level', level);
  });

  actionLayer.onNotification((notif) => {
    sendToDashboard('skipper:notification-sent', notif);
  });

  // Forward Usage Metadata from AI Provider
  if ((provider as any).onUsageMetadata) {
    (provider as any).onUsageMetadata((usage: any) => {
      sendToDashboard('skipper:usage-metadata', usage);
    });
  }

  inputLayer.on('urlChanged', (url: string) => {
    if (url && !url.startsWith('about:')) {
      configStore.updateConfig({ lastBrowserUrl: url });
      sendToDashboard('skipper:url-changed', url);
    }
  });

  provider.on('statusChange', (status: string) => {
    sendToDashboard('skipper:provider-status', status);
  });

  provider.on('error', (err: any) => {
    sendToDashboard('skipper:provider-error', err?.message || String(err));
  });
}

