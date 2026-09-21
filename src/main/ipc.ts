import { ipcMain, BrowserWindow } from 'electron';
import { InputLayer } from '../core/input/inputLayer';
import { ProcessingLayer } from '../core/processing/processingLayer';
import { ActionLayer } from '../core/action/actionLayer';
import { ISTTProvider, createSTTProvider } from '../core/stt';
import { ScreeningEngine } from '../core/llm';
import { FrameData } from '../common/types';
import { ConfigStore } from '../core/config/configStore';

export function setupIpcHandlers(
  inputLayer: InputLayer,
  processingLayer: ProcessingLayer,
  actionLayer: ActionLayer,
  sttProvider: ISTTProvider,
  screeningEngine: ScreeningEngine,
  configStore: ConfigStore,
  getDashboardWindow: () => BrowserWindow | null
): void {
  // Config handlers
  ipcMain.handle('skipper:get-config', async () => {
    return configStore.getConfig();
  });

  ipcMain.handle('skipper:save-config', async (_e, newConfig: any) => {
    const updated = configStore.updateConfig(newConfig);

    // Apply updated goals to live screening engine
    if (updated.goals) {
      screeningEngine.setUserGoals(updated.goals, updated.goalLogic);
    }

    // Apply updated thresholds
    if (updated.thresholds) {
      screeningEngine.setThresholds(updated.thresholds);
    }

    // Apply updated STT provider if provider type changed
    if (newConfig.stt && newConfig.stt.provider) {
      try {
        const newSTT = createSTTProvider({
          provider: newConfig.stt.provider,
          googleApiKey: newConfig.stt.googleApiKey,
          googleLanguageCode: newConfig.stt.languageCode,
          rollingWindowSec: newConfig.stt.rollingWindowSec,
        });
        processingLayer.setSTTProvider(newSTT);
      } catch (err: any) {
        console.warn('[IPC] Could not switch STT provider dynamically:', err?.message);
      }
    }

    return true;
  });

  ipcMain.handle('skipper:save-prompts', async (_e, prompts: { systemPrompt: string; compactPrompt: string }) => {
    configStore.savePrompts(prompts);
    return true;
  });

  ipcMain.handle('skipper:save-constants', async (_e, constants: any) => {
    configStore.saveConstants(constants);
    screeningEngine.setThresholds(constants);
    return true;
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
    return processingLayer.getStatus();
  });

  // Speaker tracks and manual teacher selection
  ipcMain.handle('skipper:get-speaker-tracks', async () => {
    return processingLayer.getSpeakerTracks();
  });

  ipcMain.handle('skipper:set-manual-teacher', async (_e, speakerId: string | null) => {
    processingLayer.setManualTeacher(speakerId);
    return true;
  });

  // Action layer handlers
  ipcMain.handle('skipper:test-notification', async (_e, reason?: string, summary?: string) => {
    const testReason = reason || '测试通知';
    const testSummary = summary || '这是一条测试弹窗提醒：Skipper 动作层接口工作正常！';
    const result = await processingLayer.testNotification(testReason, testSummary);
    sendToDashboard('skipper:screening-alert', {
      reason: testReason,
      summary: testSummary,
      matchedGoals: [testReason],
      confidence: 1.0,
      currentTopic: '测试演练',
      timestamp: Date.now(),
    });
    return result;
  });

  // Manual/mock trigger notification handler
  ipcMain.handle('skipper:mock-trigger-notification', async (_e, reason?: string, summary?: string) => {
    const manualReason = reason || '手动触发提醒';
    const manualSummary = summary || '用户在控制台手动触发了提醒测试';
    await processingLayer.testNotification(manualReason, manualSummary);
    sendToDashboard('skipper:screening-alert', {
      reason: manualReason,
      summary: manualSummary,
      matchedGoals: [manualReason],
      confidence: 1.0,
      currentTopic: '手动演练',
      timestamp: Date.now(),
    });
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

  processingLayer.on('transcriptSegment', (segment: any) => {
    sendToDashboard('skipper:transcript-segment', segment);
  });

  processingLayer.on('speakerTracksUpdated', (tracks: any) => {
    sendToDashboard('skipper:speaker-tracks-updated', tracks);
  });

  processingLayer.on('teacherChanged', (data: any) => {
    sendToDashboard('skipper:teacher-changed', data);
  });

  processingLayer.on('screeningAlert', (alert: any) => {
    sendToDashboard('skipper:screening-alert', alert);
  });

  processingLayer.on('evaluationLog', (log: any) => {
    sendToDashboard('skipper:evaluation-log', log);
  });

  actionLayer.onNotification((notif: any) => {
    sendToDashboard('skipper:notification-sent', notif);
  });

  inputLayer.on('urlChanged', (url: string) => {
    if (url && !url.startsWith('about:')) {
      configStore.updateConfig({ lastBrowserUrl: url });
      sendToDashboard('skipper:url-changed', url);
    }
  });
}
