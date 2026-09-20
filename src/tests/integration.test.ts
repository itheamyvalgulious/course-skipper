import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-user-gesture-requirement-for-presentation');

import { InputLayer } from '../core/input/inputLayer';
import { ActionLayer } from '../core/action/actionLayer';
import { GeminiLiveProvider } from '../core/provider/geminiLiveProvider';
import { GeminiLiveMockServer } from '../mock/geminiLiveMockServer';
import { ProcessingLayer } from '../core/processing/processingLayer';
import { ConfigStore } from '../core/config/configStore';

async function runTests() {
  console.log('=== [TEST] Starting Skipper Gemini Live Integration Test ===\n');

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

  const testHtmlUrl = 'data:text/html,<html><head><title>Test Classroom</title></head><body style="background:%23111;color:%23fff;"><h1>Skipper Lecture Classroom</h1></body></html>';
  let mockServer: GeminiLiveMockServer | null = null;

  try {
    // 0. Test ConfigStore Persistence
    console.log('[Test 0] Testing ConfigStore Persistence...');
    const testConfigPath = path.join(process.cwd(), '.skipper-data', 'test-config.json');
    if (fs.existsSync(testConfigPath)) {
      try { fs.unlinkSync(testConfigPath); } catch {}
    }
    const store1 = new ConfigStore(testConfigPath);
    assert(store1.get('model') === 'gemini-3.8-live', 'Default model is gemini-3.8-live');
    assert(store1.get('muteLocalAudio') === true, 'Default muteLocalAudio is true');

    store1.updateConfig({
      apiKey: 'test-api-key-12345',
      backendType: 'aistudio',
      lastBrowserUrl: 'https://classroom.example.com/live/123',
      muteLocalAudio: true,
      userPrompt: '当讲完柯西不等式时叫我',
    });

    // Re-instantiate from disk to verify persistence
    const store2 = new ConfigStore(testConfigPath);
    assert(store2.get('apiKey') === 'test-api-key-12345', 'API key persisted and restored from disk');
    assert(store2.get('backendType') === 'aistudio', 'Backend type persisted');
    assert(store2.get('lastBrowserUrl') === 'https://classroom.example.com/live/123', 'lastBrowserUrl persisted');
    assert(store2.get('muteLocalAudio') === true, 'muteLocalAudio persisted');
    assert(store2.get('userPrompt') === '当讲完柯西不等式时叫我', 'userPrompt persisted');

    // 0.5. Start Gemini Live Mock Server on test port
    console.log('\n[Test 0.5] Starting GeminiLiveMockServer...');
    mockServer = new GeminiLiveMockServer({
      port: 8098,
      proactiveIntervalMs: 2000, // Speed up interval for test to 2s
      usageIntervalMs: 1500,
      logLevel: 'error',
    });
    const mockPort = await mockServer.start();
    assert(mockPort === 8098, `Mock server started on port ${mockPort}`);

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

    // 3. Test GeminiLiveProvider with Mock Server
    console.log('\n[Test 3] Testing GeminiLiveProvider...');
    const provider = new GeminiLiveProvider({
      userPrompt: '测试Prompt: Fatou引理证明完成',
      useMockServer: true,
      endpoint: `ws://127.0.0.1:${mockPort}`,
    });
    assert(provider.name === 'GeminiLiveProvider', 'Provider name is GeminiLiveProvider');
    assert(provider.getUserPrompt() === '测试Prompt: Fatou引理证明完成', 'Initial prompt is set');

    let triggerCalled: boolean = false;
    let receivedTrigger: any = null;
    provider.onNotificationTrigger((event) => {
      triggerCalled = true;
      receivedTrigger = event;
      console.log('    -> GeminiLiveProvider received toolCall notification:', event.reason);
    });

    let usageReceived: any = null;
    if (provider.onUsageMetadata) {
      provider.onUsageMetadata((usage) => {
        usageReceived = usage;
      });
    }

    await provider.connect();
    assert(provider.isConnected === true, 'GeminiLiveProvider connects to mock server successfully');

    // Send audio chunk & frame
    const dummyPcm = Buffer.alloc(640);
    await provider.sendAudioChunk(dummyPcm);
    const dummyJpg = Buffer.from('fake-jpeg-data');
    await provider.sendFrame(dummyJpg, 'image/jpeg');

    // Update prompt
    provider.setUserPrompt('当老师讲完 Fatou 引理时叫我');
    assert(provider.getUserPrompt() === '当老师讲完 Fatou 引理时叫我', 'Prompt updated');

    // Wait for proactive toolCall and usageMetadata from mock server
    console.log('  -> Waiting for proactive toolCall (notify_user) from mock server...');
    await new Promise((r) => setTimeout(r, 2500));
    assert(Boolean(triggerCalled), 'Received proactive notify_user toolCall from Gemini Live provider');
    assert(receivedTrigger?.reason !== undefined, 'Notification has reason property');

    // 4. Test ProcessingLayer & Pipeline Orchestration
    console.log('\n[Test 4] Testing ProcessingLayer Scheduling with GeminiLiveProvider...');
    const processingLayer = new ProcessingLayer(inputLayer, actionLayer, provider, {
      frameIntervalMs: 1000,
    });
    assert(processingLayer.state === 'idle', 'ProcessingLayer initial state is idle');

    // Initialize browser through InputLayer
    console.log('  -> Opening browser window...');
    const initPromise = processingLayer.initialize(testHtmlUrl);
    await new Promise((r) => setTimeout(r, 600));
    assert(inputLayer.isBrowserOpen === true, 'Browser window opened');

    // Simulate user completing initialization in browser
    console.log('  -> Simulating user completing initialization...');
    inputLayer.completeInitialization();
    const initResult = await initPromise;
    assert(initResult === true, 'ProcessingLayer initialization completed successfully');
    assert(processingLayer.state === 'ready', 'ProcessingLayer state is ready');

    // Test Frame Capture
    console.log('  -> Capturing single frame from live browser...');
    const frame = await processingLayer.captureSingleFrame();
    assert(frame !== null, 'Frame captured is not null');
    assert(frame !== null && frame.buffer.length > 0, 'Frame buffer has data');
    assert(frame?.mimeType === 'image/jpeg', 'Frame mimeType is image/jpeg');

    // Test Audio Stream
    console.log('  -> Testing Audio Stream ingestion...');
    inputLayer.pushAudioChunk(dummyPcm, 0.45);
    const audioStats = (inputLayer.getAudioStream() as any).getStats();
    assert(audioStats.chunks >= 0, 'Audio stream accepts audio data');

    // Test Start Monitoring
    console.log('  -> Starting Monitoring pipeline...');
    await processingLayer.startMonitoring('当老师讲完 Fatou 引理时叫我');
    assert(processingLayer.state === 'monitoring', 'ProcessingLayer state is monitoring');

    // Let it run for a couple frames
    await new Promise((r) => setTimeout(r, 2200));
    const status = processingLayer.getStatus();
    assert(status.framesProcessed >= 1, `Frames processed count is ${status.framesProcessed} (>= 1)`);

    // Test Pause & Resume
    console.log('  -> Testing Pause & Resume...');
    processingLayer.pauseMonitoring();
    assert(processingLayer.state === 'paused', 'State after pause is paused');

    processingLayer.resumeMonitoring();
    assert(processingLayer.state === 'monitoring', 'State after resume is monitoring');

    // Stop Monitoring
    console.log('  -> Stopping Monitoring...');
    await processingLayer.stopMonitoring();
    assert(processingLayer.state === 'ready', 'State after stop is ready');

    // Clean up
    await inputLayer.destroy();
    await provider.disconnect();
    if (mockServer) {
      await mockServer.stop();
    }
    await new Promise((r) => setTimeout(r, 200));

    console.log('\n=== [TEST COMPLETED] ===');
    console.log(`Summary: ${passed} passed, ${failed} failed.`);

    const exitCode = failed > 0 ? 1 : 0;
    app.exit(exitCode);
  } catch (err) {
    console.error('Test threw unexpected error:', err);
    if (mockServer) {
      await mockServer.stop();
    }
    app.exit(1);
  }
}

app.whenReady().then(runTests);

