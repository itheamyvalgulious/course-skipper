process.env.SKIPPER_TEST = '1';

import {
  BaseSTTProvider,
  GoogleCloudSTTProvider,
  LocalCpuSTTProvider,
  FunAsrNanoSTTProvider,
  SileroVadDetector,
  MockSTTProvider,
  createSTTProvider,
  STTSegment,
  STTConfig,
} from '../core/stt';
import * as path from 'path';
import * as fs from 'fs';

// Helper to generate 16kHz 16-bit mono PCM buffer
function generatePcmBuffer(durationSec: number, frequencyHz: number = 440, amplitude: number = 0.5): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.floor(durationSec * sampleRate);
  const buffer = Buffer.alloc(numSamples * 2);

  for (let i = 0; i < numSamples; i++) {
    const sample = amplitude === 0
      ? 0
      : Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude * 32767;
    buffer.writeInt16LE(Math.floor(sample), i * 2);
  }

  return buffer;
}

async function runSTTTests() {
  console.log('=== [TEST] Starting STT Layer Unified Architecture Tests ===\n');

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

  // --- Test 1: BaseSTTProvider audio calculations & WAV header generation ---
  console.log('[Test 1] Testing BaseSTTProvider audio utilities & pcmToWav...');
  {
    const mock = new MockSTTProvider({ sampleRate: 16000 });
    assert(mock.calculateDurationSec(32000) === 1.0, '32000 bytes = 1.0 second at 16kHz 16-bit mono');
    assert(mock.secondsToBytes(2.5) === 80000, '2.5 seconds = 80000 bytes');

    // Silence RMS
    const silence = Buffer.alloc(3200);
    assert(mock.calculateRMS(silence) === 0, 'RMS of zero buffer is 0.0');

    // Sine wave RMS
    const sine = generatePcmBuffer(0.1, 440, 0.5);
    const rms = mock.calculateRMS(sine);
    assert(rms > 0.3 && rms < 0.4, `Sine wave RMS (~0.35) measured accurately: ${rms.toFixed(3)}`);

    // WAV header generation
    const wav = BaseSTTProvider.pcmToWav(sine, 16000, 1, 16);
    assert(wav.length === sine.length + 44, 'WAV buffer has 44-byte RIFF header');
    assert(wav.toString('ascii', 0, 4) === 'RIFF', 'WAV starts with RIFF');
    assert(wav.toString('ascii', 8, 12) === 'WAVE', 'WAV format is WAVE');
    assert(wav.readUInt32LE(24) === 16000, 'Sample rate in header is 16000');
    assert(wav.readUInt16LE(22) === 1, 'Channel count in header is 1');
    assert(wav.readUInt16LE(34) === 16, 'Bit depth in header is 16');
  }

  // --- Test 2: Factory function createSTTProvider ---
  console.log('\n[Test 2] Testing createSTTProvider factory...');
  {
    const googleProv = createSTTProvider({ provider: 'google', googleApiKey: 'test-key' });
    assert(googleProv instanceof GoogleCloudSTTProvider, 'Factory creates GoogleCloudSTTProvider for "google"');
    assert(googleProv.name === 'GoogleCloudSTTProvider', 'GoogleCloudSTTProvider name is correct');

    const cpuProv = createSTTProvider({ provider: 'cpu', rollingWindowSec: 25 });
    assert(cpuProv instanceof LocalCpuSTTProvider, 'Factory creates LocalCpuSTTProvider for "cpu"');
    assert(cpuProv.name === 'LocalCpuSTTProvider', 'LocalCpuSTTProvider name is correct');

    const funasrProv = createSTTProvider({ provider: 'funasr' });
    assert(funasrProv instanceof FunAsrNanoSTTProvider, 'Factory creates FunAsrNanoSTTProvider for "funasr"');
    assert(funasrProv.name === 'FunAsrNanoSTTProvider', 'FunAsrNanoSTTProvider name is correct');

    const mockProv = createSTTProvider({ provider: 'mock' });
    assert(mockProv instanceof MockSTTProvider, 'Factory creates MockSTTProvider for "mock"');
    assert(mockProv.name === 'MockSTTProvider', 'MockSTTProvider name is correct');
  }

  // --- Test 3: GoogleCloudSTTProvider error resilience & chunk buffering ---
  console.log('\n[Test 3] Testing GoogleCloudSTTProvider error handling & chunking...');
  {
    let errorCaught = false;
    let statusReceived = '';

    const googleProv = new GoogleCloudSTTProvider({
      provider: 'google',
      googleApiKey: '', // Empty API key to test graceful handling
      chunkDurationSec: 1.0,
    });

    googleProv.on('error', (err) => {
      errorCaught = true;
    });

    googleProv.on('status', (status) => {
      statusReceived = status;
    });

    await googleProv.start();
    assert(googleProv.isRunning, 'GoogleCloudSTTProvider started even with missing API key');
    assert(errorCaught, 'Emits error event for missing API key without crashing');

    // Feeding audio when API key is missing should emit error safely
    errorCaught = false;
    const toneAudio = generatePcmBuffer(1.2, 440, 0.5);
    googleProv.feedAudio(toneAudio);

    // Wait short time for async queue
    await new Promise((r) => setTimeout(r, 100));
    assert(errorCaught, 'Safely handles queue processing when API key is unconfigured');

    await googleProv.stop();
    assert(!googleProv.isRunning, 'GoogleCloudSTTProvider stopped successfully');
  }

  // --- Test 4: LocalCpuSTTProvider rolling buffer & VAD streaming ---
  console.log('\n[Test 4] Testing LocalCpuSTTProvider 20-30s rolling buffer & VAD...');
  {
    const cpuProv = new LocalCpuSTTProvider({
      provider: 'cpu',
      rollingWindowSec: 20, // 20 seconds rolling window
    });

    const segments: STTSegment[] = [];
    cpuProv.on('segment', (seg) => {
      segments.push(seg);
    });

    await cpuProv.start();
    assert(cpuProv.isRunning, 'LocalCpuSTTProvider started');

    // Feed audio: 3 chunks speech (1.5s) followed by 2 chunks silence (1.0s)
    for (let sec = 0; sec < 10; sec++) {
      const isSpeech = (sec % 5) < 3;
      const chunk = isSpeech
        ? generatePcmBuffer(0.5, 440, 0.5) // Speech frame
        : generatePcmBuffer(0.5, 0, 0);     // Silence frame
      cpuProv.feedAudio(chunk);
    }

    // Give VAD time to finish segmentation
    await new Promise((r) => setTimeout(r, 150));

    assert(segments.length > 0, `VAD detected speech segments: received ${segments.length} segment(s)`);
    if (segments.length > 0) {
      const first = segments[0];
      assert(typeof first.text === 'string' && first.text.length > 0, `Segment text is non-empty: "${first.text}"`);
      assert(first.startTime >= 0, `Segment startTime is valid: ${first.startTime}s`);
      assert(first.endTime > first.startTime, `Segment endTime > startTime: ${first.endTime}s`);
      assert(first.speaker === 'Teacher', `Speaker tag is Teacher: ${first.speaker}`);
      assert(first.isFinal === true, `Segment isFinal is true`);
    }

    await cpuProv.stop();
    assert(!cpuProv.isRunning, 'LocalCpuSTTProvider stopped');
  }

  // --- Test 5: MockSTTProvider segment generation & injection ---
  console.log('\n[Test 5] Testing MockSTTProvider...');
  {
    const mock = new MockSTTProvider();
    const mockSegments: STTSegment[] = [];
    mock.on('segment', (s) => mockSegments.push(s));

    await mock.start();
    assert(mock.isRunning, 'MockSTTProvider running');

    // Feed 4 seconds of audio (threshold is 3s)
    mock.feedAudio(generatePcmBuffer(4.0, 440, 0.3));
    assert(mockSegments.length >= 1, `MockSTTProvider generated ${mockSegments.length} segment(s) upon audio feeding`);

    // Test direct injection
    mock.injectSegment({
      text: '测试注入片段',
      startTime: 10.0,
      endTime: 12.5,
      speaker: 'Teacher',
      isFinal: true,
    });

    assert(mockSegments.length >= 2, 'Injected segment received');
    const last = mockSegments[mockSegments.length - 1];
    assert(last.text === '测试注入片段', 'Injected segment text verified');
    assert(last.startTime === 10.0 && last.endTime === 12.5, 'Injected segment timestamps verified');

    mock.reset();
    assert(mock.isRunning, 'MockSTTProvider remains running after reset');

    await mock.stop();
    assert(!mock.isRunning, 'MockSTTProvider stopped');
  }

  // --- Test 6: TeacherResolver & Speaker Tracks Management ---
  console.log('\n[Test 6] Testing TeacherResolver & Speaker Tracks Management...');
  {
    const { TeacherResolver } = require('../core/stt/teacherResolver');
    const resolver = new TeacherResolver();

    // 1. Record speech for speaker_00 (dominant teacher)
    resolver.recordUtterance('speaker_00', '我们来看这个最佳逼近的性质，展开之后内积为零。', 12.0, 15.0);
    // 2. Record speech for speaker_01 (student asking question)
    resolver.recordUtterance('speaker_01', '老师，这里为什么要加上绝对值？', 3.0, 18.0);

    const tracks = resolver.getSpeakerTracks();
    assert(tracks.length === 2, `Detected exactly 2 speaker tracks (got ${tracks.length})`);
    assert(tracks[0].id === 'speaker_00', `Longest speaker is speaker_00: ${tracks[0].id}`);
    assert(tracks[0].totalDurationSec === 12.0, `speaker_00 total duration is 12s`);
    assert(tracks[1].totalDurationSec === 3.0, `speaker_01 total duration is 3s`);

    // 3. Initial resolution (single initial speaker defaulted to teacher)
    assert(resolver.getResolvedSpeaker('speaker_00') === 'Teacher', 'speaker_00 resolved to Teacher');
    assert(resolver.getResolvedSpeaker('speaker_01') === 'speaker_01', 'speaker_01 resolved to speaker_01');

    // 4. Test User Manual Teacher Selection
    let teacherChangedEventFired = false;
    resolver.once('teacherChanged', (tId: string, isManual: boolean) => {
      teacherChangedEventFired = true;
      assert(tId === 'speaker_01', `Teacher changed event fired for speaker_01: ${tId}`);
      assert(isManual === true, 'isManual flag is true');
    });

    resolver.setManualTeacher('speaker_01');
    assert(teacherChangedEventFired, 'teacherChanged event received');
    assert(resolver.getResolvedSpeaker('speaker_01') === 'Teacher', 'speaker_01 now resolved to Teacher');
    assert(resolver.getResolvedSpeaker('speaker_00') === 'speaker_00', 'speaker_00 now resolved to speaker_00');

    // 5. Test switching back to Automatic LLM resolution
    resolver.setManualTeacher(null);
    assert(resolver.getManualTeacher() === null, 'Manual teacher cleared');

    // 6. Test 3-minute Automatic LLM Teacher Inference
    const mockLlmClient = {
      chatCompletion: async (messages: any[]) => {
        return {
          content: JSON.stringify({
            teacherSpeakerId: 'speaker_00',
            confidence: 0.98,
            reason: '主导定理证明与全过程板书讲解',
          }),
        };
      },
    };

    // Fast-forward stream time by 200s (> 180s interval)
    const inferred = await resolver.maybeInferTeacherViaLLM(mockLlmClient, 250);
    assert(inferred === 'speaker_00', `LLM correctly inferred teacher as speaker_00: ${inferred}`);
    assert(resolver.getResolvedSpeaker('speaker_00') === 'Teacher', 'speaker_00 resolved to Teacher via LLM');
    assert(resolver.getResolvedSpeaker('speaker_01') === 'speaker_01', 'speaker_01 stays student');

    // 7. Test LocalCpuSTTProvider speaker tracks methods
    const cpuProv = new LocalCpuSTTProvider({ provider: 'cpu' });
    assert(typeof cpuProv.getSpeakerTracks === 'function', 'cpuProv has getSpeakerTracks');
    assert(typeof cpuProv.setManualTeacher === 'function', 'cpuProv has setManualTeacher');
    cpuProv.setManualTeacher('speaker_02');
    assert(cpuProv.getTeacherResolver().getManualTeacher() === 'speaker_02', 'cpuProv setManualTeacher synced');
  }

  // --- Test 7: FunAsrNanoSTTProvider Strict Fail-Fast & Model Integration ---
  console.log('\n[Test 7] Testing FunAsrNanoSTTProvider Strict Fail-Fast & Architecture...');
  {
    // 1. Strict fail-fast when model is missing
    const missingProv = new FunAsrNanoSTTProvider({
      provider: 'funasr',
      funasrModelDir: path.join(__dirname, 'non_existent_model_dir_for_test'),
    });

    let caughtError = false;
    let emittedError = false;
    missingProv.on('error', (err) => {
      emittedError = true;
    });

    try {
      await missingProv.start();
    } catch (err: any) {
      caughtError = true;
      assert(
        err.message.includes('missing') || err.message.includes('not found'),
        `Fail-fast error thrown when model missing: "${err.message}"`
      );
    }

    assert(caughtError, 'FunAsrNanoSTTProvider throws error immediately when model files missing');
    assert(emittedError, 'FunAsrNanoSTTProvider emits "error" event on missing model');
    assert(!missingProv.isRunning, 'FunAsrNanoSTTProvider is not running after fail-fast');

    // 2. Test speaker tracks and manual teacher on FunAsrNanoSTTProvider
    assert(typeof missingProv.getSpeakerTracks === 'function', 'FunAsrNanoSTTProvider has getSpeakerTracks');
    assert(typeof missingProv.setManualTeacher === 'function', 'FunAsrNanoSTTProvider has setManualTeacher');
    missingProv.setManualTeacher('speaker_03');
    assert(missingProv.getTeacherResolver().getManualTeacher() === 'speaker_03', 'FunAsr setManualTeacher synced');

    // 3. Test with real model if present
    const defaultProv = new FunAsrNanoSTTProvider({ provider: 'funasr' });
    if (defaultProv.isModelReady()) {
      console.log('  -> Real Fun-ASR-Nano model verified ready! Testing initialization...');
      await defaultProv.start();
      assert(defaultProv.isRunning, 'FunAsrNanoSTTProvider started successfully with real model');
      defaultProv.feedAudio(generatePcmBuffer(0.2, 440, 0.5));
      await defaultProv.stop();
      assert(!defaultProv.isRunning, 'FunAsrNanoSTTProvider stopped successfully');
    } else {
      console.log('  -> Fun-ASR-Nano real model not yet fully present, fail-fast behavior verified.');
    }
  }

  // -------------------------------------------------------------
  // Test 8: Testing SileroVadDetector and Degenerate Loop Cleaner
  // -------------------------------------------------------------
  console.log('\n[Test 8] Testing SileroVadDetector and Degenerate Loop Cleaner...');
  {
    // 1. Test fail-fast on missing model
    let vadCaught = false;
    try {
      new SileroVadDetector({ vadModelPath: 'non_existent_silero.onnx' });
    } catch (e: any) {
      vadCaught = true;
      assert(e.message.includes('silero_vad.onnx model missing'), 'SileroVadDetector throws fail-fast error on missing model');
    }
    assert(vadCaught, 'SileroVadDetector verified fail-fast on missing model');

    // 2. Test real SileroVadDetector
    const realVad = new SileroVadDetector();
    assert(fs.existsSync(realVad.getModelPath()), 'Real Silero-VAD model exists');

    // Test with silence PCM
    const silentPcm = Buffer.alloc(16000 * 2 * 0.5); // 0.5s silence
    const silentRes = await realVad.detectSpeech(silentPcm);
    assert(!silentRes.hasSpeech, 'Silero-VAD correctly detects silence as non-speech');

    // 3. Test cleanDegenerateRepetitions
    const prov = new FunAsrNanoSTTProvider({ provider: 'funasr' });
    // Single character loop
    assert(prov.cleanDegenerateRepetitions('执执执执执执执执执执') === '', 'cleanDegenerateRepetitions drops pure single character loop');
    // Word loop
    const cleanedTask = prov.cleanDegenerateRepetitions('task task task task task task');
    assert(!cleanedTask.includes('task task task'), 'cleanDegenerateRepetitions compresses word loop');
    // Pure English hallucination filter in zh mode
    assert(prov.cleanDegenerateRepetitions('game of course') === '', 'cleanDegenerateRepetitions drops short pure English noise hallucination');
    assert(prov.cleanDegenerateRepetitions('lincoln') === '', 'cleanDegenerateRepetitions drops standalone lincoln');
    // Legitimate math / mixed sentence preserved
    const mathSentence = '因此直接导出不等式 ||f - Tn||^2 恒大于等于零';
    assert(prov.cleanDegenerateRepetitions(mathSentence) === mathSentence, 'cleanDegenerateRepetitions preserves valid lecture math sentence');
  }

  console.log('\n========================================');
  console.log(`STT Test Summary: Passed: ${passed} | Failed: ${failed}`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSTTTests().catch((err) => {
  console.error('[FATAL] STT Test Error:', err);
  process.exit(1);
});
