import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-user-gesture-requirement-for-presentation');

import { InputLayer } from '../core/input/inputLayer';
import { ActionLayer } from '../core/action/actionLayer';
import { createSTTProvider, MockSTTProvider, STTSegment } from '../core/stt';
import { ScreeningEngine, LLMClient, ScreeningVerdict } from '../core/llm';
import { ProcessingLayer } from '../core/processing/processingLayer';
import { ConfigStore } from '../core/config/configStore';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
} from '../core/config/constants';

async function runTests() {
  console.log('=== [TEST] Starting Skipper STT + LLM Screening Integration Tests ===\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${msg}`);
      failed++;
    }
  }

  const testHtmlUrl =
    'data:text/html,<html><head><title>Test Classroom</title></head><body style="background:%23111;color:%23fff;"><h1>Skipper Lecture Classroom</h1></body></html>';

  try {
    // 0. Test ConfigStore Persistence
    console.log('[Test 0] Testing ConfigStore Persistence...');
    const testConfigPath = path.join(process.cwd(), '.skipper-data', 'test-config-v2.json');
    if (fs.existsSync(testConfigPath)) {
      try {
        fs.unlinkSync(testConfigPath);
      } catch {}
    }
    const store1 = new ConfigStore(testConfigPath);
    assert(Array.isArray(store1.getGoals()), 'Default config goals is an array');
    store1.addGoal('测试目标：老师开始提问');
    assert(store1.getGoals().length === 1, 'Goal can be added dynamically');
    assert(store1.getGoalLogic() === 'OR', 'Default goalLogic is OR');
    assert(store1.getLLMConfig().model === DEFAULT_LLM_MODEL, 'Default model matches deepseek-v4-flash');

    store1.updateConfig({
      llm: {
        baseUrl: 'http://35.208.205.93:20000/v1',
        apiKey: 'test-key-abc',
        model: 'gemini-3.8-flash',
        maxContextTokens: 8192,
        compactRatio: 0.6,
      },
      lastBrowserUrl: 'https://classroom.example.com/live/123',
      muteLocalAudio: true,
    });

    // Re-instantiate from disk to verify persistence
    const store2 = new ConfigStore(testConfigPath);
    assert(store2.getLLMConfig().apiKey === 'test-key-abc', 'API key persisted and restored from disk');
    assert(store2.getConfig().lastBrowserUrl === 'https://classroom.example.com/live/123', 'lastBrowserUrl persisted');
    assert(store2.getConfig().muteLocalAudio === true, 'muteLocalAudio persisted');

    // 1. Test InputLayer instantiation & initial state
    console.log('\n[Test 1] Testing InputLayer & Audio Muting...');
    const inputLayer = new InputLayer({
      partition: 'persist:skipper-test',
      defaultUrl: testHtmlUrl,
      muteLocalPlayback: true,
    });
    assert(inputLayer.isInitialized === false, 'InputLayer starts uninitialized');
    assert(inputLayer.isBrowserOpen === false, 'Browser window starts closed');
    assert(inputLayer.getMuteLocalPlayback() === true, 'InputLayer local audio playback muting is enabled by default');

    inputLayer.setMuteLocalPlayback(false);
    assert(inputLayer.getMuteLocalPlayback() === false, 'InputLayer local audio muting toggled to false');
    inputLayer.setMuteLocalPlayback(true);
    assert(inputLayer.getMuteLocalPlayback() === true, 'InputLayer local audio muting toggled back to true');

    // 2. Test ActionLayer
    console.log('\n[Test 2] Testing ActionLayer...');
    const actionLayer = new ActionLayer();
    let notificationReceived: any = null;
    actionLayer.onNotification((notif) => {
      notificationReceived = notif;
    });

    const notifSent = await actionLayer.notify('测试原因', '测试摘要：证明完成');
    assert(notifSent === true || notifSent === false, 'ActionLayer notify returns boolean');
    assert(notificationReceived !== null, 'ActionLayer emitted notification event');
    assert(notificationReceived?.reason === '测试原因', 'Notification reason matches');

    // 3. Test STT Provider
    console.log('\n[Test 3] Testing STT Provider Factory & Segment Emission...');
    const mockSTT = new MockSTTProvider();
    let emittedSegment: STTSegment | null = null;
    mockSTT.on('segment', (seg) => {
      emittedSegment = seg;
    });

    await mockSTT.start();
    assert(mockSTT.isRunning === true, 'Mock STT Provider is running');

    mockSTT.injectSegment({
      text: 'OK，那这个式子就证完了对不对？',
      startTime: 220.0,
      endTime: 223.5,
      speaker: 'Teacher',
      isFinal: true,
    });

    assert(emittedSegment !== null, 'STT Provider emitted segment event');
    assert((emittedSegment as any)?.text === 'OK，那这个式子就证完了对不对？', 'Emitted segment text matches');

    // 4. Test LLMClient & ScreeningEngine
    console.log('\n[Test 4] Testing ScreeningEngine Integration...');
    const mockLLMClient = {
      chatCompletion: async () => ({
        content: JSON.stringify({
          triggered: true,
          matchedGoals: ['一个知识点,证明或题目已经讲解完成,且已经开始讲解下一个内容板块'],
          confidence: 0.98,
          currentTopic: '完备性定义',
          reason: '老师已完成最佳逼近推导并宣布进入完备性新板块',
          summary: '最佳逼近定理讲解完毕，完备性定义开始',
        }),
      }),
    } as unknown as LLMClient;

    const screeningEngine = new ScreeningEngine({
      llmClient: mockLLMClient,
      goals: [
        {
          id: 'test-goal-1',
          text: '一个知识点,证明或题目已经讲解完成,且已经开始讲解下一个内容板块',
          enabled: true,
        },
      ],
      thresholds: {
        pauseThresholdSec: 0.1, // fast for testing
        minIntervalSec: 0.1,
        maxIntervalSec: 10.0,
      },
    });

    let alertReceived: ScreeningVerdict | null = null;
    screeningEngine.on('alert', (v) => {
      alertReceived = v;
    });

    screeningEngine.attachSTT(mockSTT);
    mockSTT.injectSegment({
      text: '好，稍微等一下哈，下面讲完备性。',
      startTime: 366.0,
      endTime: 370.0,
      speaker: 'Teacher',
      isFinal: true,
    });

    await screeningEngine.triggerManualEvaluation('TestTrigger');
    assert(alertReceived !== null, 'ScreeningEngine alert emitted upon trigger evaluation');
    assert((alertReceived as any)?.triggered === true, 'ScreeningVerdict triggered is true');
    assert(
      (alertReceived as any)?.reason.includes('完备性'),
      'ScreeningVerdict reason accurately mentions topic transition'
    );

    // 5. Test ProcessingLayer Scheduling Pipeline
    console.log('\n[Test 5] Testing ProcessingLayer Pipeline...');
    const processingLayer = new ProcessingLayer(inputLayer, actionLayer, mockSTT, screeningEngine, {
      frameIntervalMs: 1000,
      autoStartOnReady: false,
    });

    assert(processingLayer.state === 'idle', 'ProcessingLayer begins in idle state');

    // Start monitoring
    await processingLayer.startMonitoring();
    assert(processingLayer.state === 'monitoring', 'ProcessingLayer transitions to monitoring state');
    assert(processingLayer.getStatus().isAiConnected === true, 'Status reflects STT active');

    // Push audio chunks through input layer to verify pipe
    inputLayer.pushAudioChunk(Buffer.alloc(3200), 45);
    assert(processingLayer.getStatus().audioLevel === 45, 'Audio level passed through to ProcessingLayer');

    // Pause & Resume
    processingLayer.pauseMonitoring();
    assert(processingLayer.state === 'paused', 'ProcessingLayer transitions to paused state');

    processingLayer.resumeMonitoring();
    assert(processingLayer.state === 'monitoring', 'ProcessingLayer resumes monitoring state');

    // Stop monitoring
    await processingLayer.stopMonitoring();
    assert(processingLayer.state === 'idle' || processingLayer.state === 'ready', 'ProcessingLayer stops cleanly');

    // Clean up
    await mockSTT.stop();
    await inputLayer.destroy();

    // Clean up test config
    if (fs.existsSync(testConfigPath)) {
      try {
        fs.unlinkSync(testConfigPath);
      } catch {}
    }
  } catch (err: any) {
    console.error('Test execution threw unhandled exception:', err);
    failed++;
  }

  console.log('\n==================================================');
  console.log(`Integration Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================\n');

  if (failed > 0) {
    app.exit(1);
  } else {
    app.exit(0);
  }
}

app.whenReady().then(runTests);
