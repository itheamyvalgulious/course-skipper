/**
 * Unit & Integration Tests for Skipper LLM & Screening Engine
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  PAUSE_THRESHOLD_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_COMPACT_THRESHOLD_RATIO,
  DEFAULT_GOALS,
  DEFAULT_GOAL_LOGIC,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_COMPACT_PROMPT,
} from '../core/config/constants';
import { ConfigStore } from '../core/config/configStore';
import { LLMClient } from '../core/llm/llmClient';
import { ScreeningEngine } from '../core/llm/screeningEngine';
import {
  GoalItem,
  GoalLogic,
  ScreeningVerdict,
  EvaluationLog,
  CompactState,
  STTSegment,
  ISTTProvider,
} from '../core/llm/types';

class MockSTTProvider extends EventEmitter implements ISTTProvider {
  public readonly name = 'MockSTTProvider';
  public readonly isRunning = true;
  public start(): Promise<void> { return Promise.resolve(); }
  public stop(): Promise<void> { return Promise.resolve(); }
  public feedAudio(_chunk: Buffer): void {}
  public reset(): void {}
  public emitSegment(seg: STTSegment): void {
    this.emit('segment', seg);
  }
}

async function runScreeningTests() {
  console.log('=== [TEST] Starting LLM & Screening Engine Unit Tests ===\n');
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

  try {
    // -------------------------------------------------------------
    // Test 1: Constants Verification
    // -------------------------------------------------------------
    console.log('[Test 1] Constants verification...');
    assert(PAUSE_THRESHOLD_SECONDS === 3.0, 'PAUSE_THRESHOLD_SECONDS is 3.0');
    assert(MIN_INTERVAL_SECONDS === 10.0, 'MIN_INTERVAL_SECONDS is 10.0');
    assert(MAX_INTERVAL_SECONDS === 60.0, 'MAX_INTERVAL_SECONDS is 60.0');
    assert(DEFAULT_MAX_CONTEXT_TOKENS === 8192, 'DEFAULT_MAX_CONTEXT_TOKENS is 8192');
    assert(DEFAULT_COMPACT_THRESHOLD_RATIO === 0.60, 'DEFAULT_COMPACT_THRESHOLD_RATIO is 0.60');
    assert(DEFAULT_GOAL_LOGIC === 'OR', 'DEFAULT_GOAL_LOGIC is OR');
    assert(Array.isArray(DEFAULT_GOALS), 'DEFAULT_GOALS is array');
    assert(DEFAULT_GOALS.length === 0, 'DEFAULT_GOALS is decoupled and empty by default');
    assert(DEFAULT_LLM_BASE_URL === 'https://api.deepseek.com', 'DEFAULT_LLM_BASE_URL matches requirement');
    assert(DEFAULT_LLM_API_KEY === 'sk-a1cb432e809a48f1887013e73f09d96b', 'DEFAULT_LLM_API_KEY matches requirement');
    assert(DEFAULT_LLM_MODEL === 'deepseek-v4-flash', 'DEFAULT_LLM_MODEL is deepseek-v4-flash');
    assert(DEFAULT_SYSTEM_PROMPT.includes('triggered'), 'DEFAULT_SYSTEM_PROMPT contains triggered specification');
    assert(DEFAULT_COMPACT_PROMPT.includes('已完成内容'), 'DEFAULT_COMPACT_PROMPT contains compacting instructions');

    // -------------------------------------------------------------
    // Test 2: ConfigStore CRUD & Persistence
    // -------------------------------------------------------------
    console.log('\n[Test 2] ConfigStore CRUD & Persistence...');
    const testConfigDir = path.join(process.cwd(), '.skipper-data');
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true });
    const testConfigPath = path.join(testConfigDir, 'test-llm-config.json');
    if (fs.existsSync(testConfigPath)) fs.unlinkSync(testConfigPath);

    const configStore = new ConfigStore(testConfigPath);
    const initialConfig = configStore.getConfig();
    assert(Array.isArray(initialConfig.goals), 'Initial config goals is array');
    assert(initialConfig.goals.length === 0, 'Initial config goals starts empty and decoupled');
    assert(initialConfig.goalLogic === 'OR', 'Initial goalLogic is OR');
    assert(initialConfig.llm.model === 'deepseek-v4-flash', 'Initial llm.model is deepseek-v4-flash');
    assert(initialConfig.thresholds.pauseThresholdSec === 3.0, 'Initial pause threshold is 3.0s');

    // Add and update goal
    const newGoal = configStore.addGoal('测试目标：老师开始提问');
    assert(newGoal.text === '测试目标：老师开始提问', 'Added new goal');
    assert(configStore.getConfig().goals.length === 1, 'Goal count incremented to 1');

    const updated = configStore.updateGoal(newGoal.id, { enabled: false });
    assert(updated === true, 'Updated goal status');
    assert(configStore.getConfig().goals.find(g => g.id === newGoal.id)?.enabled === false, 'Goal disabled in config');

    configStore.setGoalLogic('AND');
    assert(configStore.getConfig().goalLogic === 'AND', 'Goal logic updated to AND');

    // Update nested LLM & Thresholds
    configStore.updateLLMConfig({ maxContextTokens: 4096 });
    assert(configStore.getConfig().llm.maxContextTokens === 4096, 'LLM maxContextTokens updated');

    configStore.updateThresholds({ pauseThresholdSec: 4.5 });
    assert(configStore.getConfig().thresholds.pauseThresholdSec === 4.5, 'pauseThresholdSec updated');

    // Reload from disk to verify persistence
    const reloadedStore = new ConfigStore(testConfigPath);
    assert(reloadedStore.getConfig().goals.length === 1, 'Persisted goals count restored');
    assert(reloadedStore.getConfig().goalLogic === 'AND', 'Persisted goal logic restored');
    assert(reloadedStore.getConfig().llm.maxContextTokens === 4096, 'Persisted maxContextTokens restored');
    assert(reloadedStore.getConfig().thresholds.pauseThresholdSec === 4.5, 'Persisted pause threshold restored');

    // Cleanup test config file
    try { fs.unlinkSync(testConfigPath); } catch {}

    // -------------------------------------------------------------
    // Test 3: LLMClient chatCompletion & error handling
    // -------------------------------------------------------------
    console.log('\n[Test 3] LLMClient mock & request formatting...');
    const originalFetch = global.fetch;

    let capturedUrl = '';
    let capturedHeaders: any = null;
    let capturedBody: any = null;

    (global as any).fetch = async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  triggered: true,
                  matchedGoals: ['goal-1'],
                  confidence: 0.95,
                  currentTopic: '极限的定义与证明',
                  reason: '老师已完成Cauchy准则证明并宣布进入例题讲解',
                  summary: 'Cauchy准则证明完毕，转入例题',
                }),
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
        }),
      };
    };

    const client = new LLMClient({
      baseUrl: 'http://mock-llm.local/v1',
      apiKey: 'mock-test-key',
      defaultModel: 'deepseek-v4-flash',
    });

    const completion = await client.chatCompletion(
      [{ role: 'system', content: 'test-sys' }, { role: 'user', content: 'test-user' }],
      { jsonMode: true }
    );

    assert(capturedUrl === 'http://mock-llm.local/v1/chat/completions', 'Target endpoint is /v1/chat/completions');
    assert(capturedHeaders['Authorization'] === 'Bearer mock-test-key', 'Bearer auth header sent');
    assert(capturedBody.response_format?.type === 'json_object', 'jsonMode flag translated to response_format');
    assert(completion.content.includes('"triggered"'), 'Completion content returned successfully');
    assert(completion.usage?.total_tokens === 165, 'Usage metadata received');

    // Test API error handling
    (global as any).fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API key provided',
    });

    let errorThrown = false;
    try {
      await client.chatCompletion([{ role: 'user', content: 'hello' }]);
    } catch (err: any) {
      errorThrown = true;
      assert(err.message.includes('401') && err.message.includes('Unauthorized'), 'Handled HTTP 401 correctly');
    }
    assert(errorThrown, 'LLMClient threw error on non-ok HTTP status');

    // -------------------------------------------------------------
    // Test 4: ScreeningEngine triggers, evaluation, and compacting
    // -------------------------------------------------------------
    console.log('\n[Test 4] ScreeningEngine triggers, evaluation, and compacting...');

    let lastSentPrompt = '';
    (global as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      lastSentPrompt = body.messages[1].content;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  triggered: true,
                  matchedGoals: ['goal-1'],
                  confidence: 0.92,
                  currentTopic: '多元函数偏导数计算',
                  reason: '老师板书例题计算完毕，总结了全微分求解公式',
                  summary: '偏导数例题讲解完毕',
                }),
              },
            },
          ],
          usage: { total_tokens: 300 },
        }),
      };
    };

    const engine = new ScreeningEngine({
      llmClient: client,
      goals: [
        {
          id: 'goal-1',
          text: '例题计算完毕并讲解全微分公式',
          enabled: true,
        },
      ],
      pauseThresholdSec: 1.0,  // Fast threshold for unit test
      minIntervalSec: 2.0,
      maxIntervalSec: 5.0,
      maxContextTokens: 100,  // Small context window to test compacting
      compactRatio: 0.60,
      checkIntervalMs: 100,
    });

    const mockSTT = new MockSTTProvider();
    engine.attachSTT(mockSTT);

    let alertEvent: ScreeningVerdict | null = null;
    let evalLogEvent: EvaluationLog | null = null;
    let compactEvent: CompactState | null = null;

    engine.on('alert', (verdict) => { alertEvent = verdict; });
    engine.on('evaluation', (log) => { evalLogEvent = log; });
    engine.on('compact', (state) => { compactEvent = state; });

    // Test STT segment ingestion
    mockSTT.emitSegment({
      text: '同学们，我们今天来看 Cauchy-Schwarz 不等式的证明。',
      startTime: 10,
      endTime: 15,
      speaker: 'Teacher',
      isFinal: true,
    });

    assert(engine.getUncompactedSegments().length === 1, 'Segment added to uncompactedSegments');
    assert(engine.getUncompactedSegments()[0].text.includes('Cauchy-Schwarz'), 'Segment content stored');

    // Test manual evaluation
    const evalVerdict = await engine.evaluate('manual');
    assert(evalVerdict !== null, 'Evaluation returned verdict');
    assert(evalVerdict?.triggered === true, 'ScreeningVerdict triggered is true');
    assert(evalVerdict?.matchedGoals.includes('goal-1') === true, 'Matched goal-1');
    assert(alertEvent !== null, 'ScreeningEngine emitted alert event');
    assert(evalLogEvent !== null, 'ScreeningEngine emitted evaluation log event');
    assert((evalLogEvent as any)?.triggerType === 'manual', 'Evaluation log triggerType is manual');
    assert(lastSentPrompt.includes('[00:10] Teacher: 同学们'), 'Prompt contains formatted [MM:SS] timestamp and speaker');

    // Test Markdown-wrapped JSON parsing fallback
    (global as any).fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [
          {
            message: {
              content: '```json\n{"triggered":false,"matchedGoals":[],"confidence":0.8,"reason":"仍在推导中","summary":"推导中"}\n```',
            },
          },
        ],
      }),
    });

    const markdownVerdict = await engine.evaluate('manual');
    assert(markdownVerdict?.triggered === false, 'Parsed markdown-wrapped JSON correctly');
    assert(markdownVerdict?.reason === '仍在推导中', 'Verdict reason extracted');

    // Test Context Compacting (exceeding 60% of 100 tokens = 60 tokens, ~150 characters)
    console.log('\n[Test 5] Testing Context Window Compacting...');
    let compactPromptCalled: any = false;
    (global as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.messages[0].content === DEFAULT_COMPACT_PROMPT) {
        compactPromptCalled = true;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [
            {
              message: {
                content: '【已完成内容】证明了Cauchy-Schwarz不等式。\n【当前状态】老师准备出随堂练习题。\n【关键结论】|(u, v)| <= ||u||*||v||。',
              },
            },
          ],
        }),
      };
    };

    // Add multiple long segments to exceed token threshold
    for (let i = 0; i < 5; i++) {
      engine.addSegment({
        text: `这是一段非常冗长的课堂讲解文字内容，老师正在黑板上逐步进行公式推导与代数展开计算，第 ${i + 1} 步细节非常繁琐，需要消耗较多字符。`,
        startTime: 20 + i * 10,
        endTime: 25 + i * 10,
        speaker: 'Teacher',
        isFinal: true,
      });
    }

    assert(engine.shouldCompact() === true, 'shouldCompact is true when context tokens exceed threshold');
    const compactResult = await engine.compact();
    assert(compactResult !== null, 'Compact executed successfully');
    assert(compactPromptCalled === true, 'LLM called with DEFAULT_COMPACT_PROMPT');
    assert(engine.getLastCompactResult().includes('Cauchy-Schwarz'), 'Compact summary stored');
    assert(engine.getStats().compactedCount >= 3, 'Included segments were compacted');
    if (engine.getUncompactedSegments().length > 0) {
      await engine.compact();
    }
    assert(engine.getUncompactedSegments().length === 0, 'Uncompacted segments emptied after compaction');

    // Clean up
    engine.stop();
    engine.detachSTT();
    global.fetch = originalFetch;

    console.log(`\n=== [TEST COMPLETED] Passed: ${passed}, Failed: ${failed} ===`);
    if (failed > 0) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    console.error('Test threw unexpected exception:', err);
    process.exit(1);
  }
}

runScreeningTests();
