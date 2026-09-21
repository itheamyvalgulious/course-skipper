/**
 * Skipper - LLM Screening Engine
 *
 * Real-time lecture monitoring engine that:
 * 1. Collects STT speech segments
 * 2. Compresses context history when window threshold (60%) is reached
 * 3. Triggers LLM evaluations based on speech pause (3s) or timeout (60s)
 * 4. Determines whether classroom monitoring goals are satisfied
 * 5. Emits 'alert', 'evaluation', and 'compact' events
 */

import { EventEmitter } from 'events';
import {
  GoalItem,
  GoalLogic,
  ScreeningVerdict,
  EvaluationLog,
  CompactState,
  STTSegment,
  ISTTProvider,
} from './types';
import { LLMClient } from './llmClient';
import {
  DEFAULT_GOALS,
  DEFAULT_GOAL_LOGIC,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_COMPACT_THRESHOLD_RATIO,
  PAUSE_THRESHOLD_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from '../config/constants';
import { ConfigStore } from '../config/configStore';

export interface ScreeningEngineOptions {
  llmClient: LLMClient;
  configStore?: ConfigStore;
  goals?: GoalItem[];
  goalLogic?: GoalLogic;
  systemPrompt?: string;
  compactPrompt?: string;
  maxContextTokens?: number;
  compactRatio?: number;
  compactThresholdRatio?: number;
  thresholds?: {
    pauseThresholdSec?: number;
    minIntervalSec?: number;
    maxIntervalSec?: number;
  };
  pauseThresholdSec?: number;
  minIntervalSec?: number;
  maxIntervalSec?: number;
  checkIntervalMs?: number;
}

export class ScreeningEngine extends EventEmitter {
  private llmClient: LLMClient;
  private configStore?: ConfigStore;

  // Runtime State
  private uncompactedSegments: STTSegment[] = [];
  private lastCompactResult: string = '';
  private lastLlmCallTime: number = 0;
  private lastSpeechTime: number = 0;
  private lastSpeechStreamSec: number = 0;
  private lastLlmCallStreamSec: number = 0;
  private lastAlertedTopic: string = '';
  private lastCompactTimestamp: number = 0;
  private compactedSegmentsCount: number = 0;
  private sessionStartTime: number = Date.now();

  // Control Flags
  private isEvaluating: boolean = false;
  private isCompacting: boolean = false;
  private isRunning: boolean = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private checkIntervalMs: number;
  private compactPromise: Promise<CompactState | null> | null = null;
  private evalPromise: Promise<ScreeningVerdict | null> | null = null;

  // Configuration Properties
  private goals: GoalItem[];
  private goalLogic: GoalLogic;
  private systemPrompt: string;
  private compactPrompt: string;
  private maxContextTokens: number;
  private compactRatio: number;
  private pauseThresholdSec: number;
  private minIntervalSec: number;
  private maxIntervalSec: number;

  // STT attachment
  private attachedSTT: ISTTProvider | null = null;
  private sttSegmentListener: ((seg: STTSegment) => void) | null = null;

  constructor(options: ScreeningEngineOptions) {
    super();

    this.llmClient = options.llmClient;
    this.configStore = options.configStore;

    // Read from configStore if provided, with options as override, falling back to defaults
    const cfg = this.configStore ? this.configStore.getConfig() : null;

    this.goals = options.goals || (cfg ? cfg.goals : [...DEFAULT_GOALS]);
    this.goalLogic = options.goalLogic || (cfg ? cfg.goalLogic : DEFAULT_GOAL_LOGIC);
    this.systemPrompt =
      options.systemPrompt || (cfg ? cfg.prompts.systemPrompt : DEFAULT_SYSTEM_PROMPT);
    this.compactPrompt =
      options.compactPrompt || (cfg ? cfg.prompts.compactPrompt : DEFAULT_COMPACT_PROMPT);
    this.maxContextTokens =
      options.maxContextTokens ?? (cfg ? cfg.llm.maxContextTokens : DEFAULT_MAX_CONTEXT_TOKENS);
    this.compactRatio =
      options.compactRatio ??
      options.compactThresholdRatio ??
      (cfg ? cfg.llm.compactRatio : DEFAULT_COMPACT_THRESHOLD_RATIO);
    this.pauseThresholdSec =
      options.thresholds?.pauseThresholdSec ??
      options.pauseThresholdSec ??
      (cfg ? cfg.thresholds.pauseThresholdSec : PAUSE_THRESHOLD_SECONDS);
    this.minIntervalSec =
      options.thresholds?.minIntervalSec ??
      options.minIntervalSec ??
      (cfg ? cfg.thresholds.minIntervalSec : MIN_INTERVAL_SECONDS);
    this.maxIntervalSec =
      options.thresholds?.maxIntervalSec ??
      options.maxIntervalSec ??
      (cfg ? cfg.thresholds.maxIntervalSec : MAX_INTERVAL_SECONDS);
    this.checkIntervalMs = options.checkIntervalMs ?? 500;
  }

  /**
   * Starts the monitoring loop.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.sessionStartTime = Date.now();

    this.checkTimer = setInterval(() => {
      this.checkTriggerRules().catch((err) => {
        console.error('[ScreeningEngine] Error checking trigger rules:', err);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stops the monitoring loop.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  public getLLMClient(): LLMClient {
    return this.llmClient;
  }

  /**
   * Attaches an STT provider and subscribes to its speech segments.
   */
  public attachSTT(provider: ISTTProvider): void {
    if (this.attachedSTT) {
      this.detachSTT();
    }
    this.attachedSTT = provider;
    this.sttSegmentListener = (segment: STTSegment) => {
      this.addSegment(segment);
    };
    provider.on('segment', this.sttSegmentListener);
  }

  /**
   * Detaches the currently attached STT provider.
   */
  public detachSTT(): void {
    if (this.attachedSTT && this.sttSegmentListener) {
      if (typeof this.attachedSTT.off === 'function') {
        this.attachedSTT.off('segment', this.sttSegmentListener);
      } else if (typeof this.attachedSTT.removeListener === 'function') {
        this.attachedSTT.removeListener('segment', this.sttSegmentListener);
      }
      this.attachedSTT = null;
      this.sttSegmentListener = null;
    }
  }

  /**
   * Ingests a new STTSegment directly.
   */
  public addSegment(segment: STTSegment): void {
    if (!segment || !segment.text || segment.text.trim().length === 0) {
      return;
    }

    const now = Date.now();
    this.lastSpeechTime = now;
    if (segment.timestamp && segment.timestamp > 0) {
      this.lastSpeechTime = Math.max(this.lastSpeechTime, segment.timestamp);
    }

    const segStart = segment.startTime !== undefined ? segment.startTime : 0;
    const segEnd = segment.endTime !== undefined ? segment.endTime : segStart + 2;

    // Check pause based on stream timestamps
    if (this.lastSpeechStreamSec > 0 && segStart > this.lastSpeechStreamSec) {
      const streamPause = segStart - this.lastSpeechStreamSec;
      const streamSinceLastCall = segStart - this.lastLlmCallStreamSec;
      if (streamPause >= this.pauseThresholdSec && streamSinceLastCall >= this.minIntervalSec) {
        this.evaluate('pause').catch(() => {});
      }
    }

    // Check timeout based on stream timestamps
    if (this.lastLlmCallStreamSec > 0 && segEnd - this.lastLlmCallStreamSec >= this.maxIntervalSec) {
      this.evaluate('timeout').catch(() => {});
    }

    this.lastSpeechStreamSec = Math.max(this.lastSpeechStreamSec, segEnd);

    this.uncompactedSegments.push(segment);

    // Check if context threshold reached to auto-compact
    if (this.shouldCompact() && !this.isCompacting) {
      this.compact().catch((err) => {
        console.warn('[ScreeningEngine] Auto-compacting failed:', err?.message);
      });
    }
  }

  /**
   * Checks trigger rules periodically.
   * - Speech pause: no new speech >= pauseThresholdSec AND time since last LLM call >= minIntervalSec
   * - Timeout: time since last LLM call >= maxIntervalSec (if uncompacted segments exist)
   */
  public async checkTriggerRules(): Promise<void> {
    if (!this.isRunning || this.isEvaluating || this.isCompacting) {
      return;
    }

    if (this.uncompactedSegments.length === 0) {
      return;
    }

    if (this.lastSpeechTime === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceSpeechSec = (now - this.lastSpeechTime) / 1000;
    const timeSinceLastCallSec =
      this.lastLlmCallTime === 0 ? Infinity : (now - this.lastLlmCallTime) / 1000;

    const isPauseTriggered =
      timeSinceSpeechSec >= this.pauseThresholdSec &&
      timeSinceLastCallSec >= this.minIntervalSec;

    const isTimeoutTriggered = timeSinceLastCallSec >= this.maxIntervalSec;

    if (isPauseTriggered) {
      await this.evaluate('pause');
    } else if (isTimeoutTriggered) {
      await this.evaluate('timeout');
    }
  }

  /**
   * Estimates total context tokens.
   * Uses ~2.5 chars per token approximation for mixed Chinese/English lecture content.
   */
  public estimateTokens(text: string): number {
    return Math.ceil(text.length / 2.5);
  }

  /**
   * Calculates current context token usage.
   */
  public getCurrentContextTokens(): number {
    const summaryChars = this.lastCompactResult.length;
    const segmentsChars = this.uncompactedSegments.reduce(
      (sum, s) => sum + (s.text ? s.text.length + 20 : 0),
      0
    );
    return this.estimateTokens(' '.repeat(summaryChars + segmentsChars));
  }

  /**
   * Checks whether the current context size meets or exceeds the compacting ratio (default 60%).
   */
  public shouldCompact(): boolean {
    const currentTokens = this.getCurrentContextTokens();
    const thresholdTokens = this.maxContextTokens * this.compactRatio;
    return currentTokens >= thresholdTokens && this.uncompactedSegments.length > 0;
  }

  /**
   * Compresses the transcript history using LLM with DEFAULT_COMPACT_PROMPT.
   * On completion, updates lastCompactResult and empties the compacted segments.
   */
  public async compact(): Promise<CompactState | null> {
    if (this.compactPromise) {
      return this.compactPromise;
    }
    if (this.uncompactedSegments.length === 0) {
      return null;
    }

    this.isCompacting = true;
    this.compactPromise = (async () => {
      const segmentsToCompact = [...this.uncompactedSegments];

      try {
        const formattedTranscript = segmentsToCompact
          .map((s) => `[${this.formatTime(s)}] ${s.speaker || 'Teacher'}: ${s.text}`)
          .join('\n');

        const userMessage = `【此前课堂压缩摘要】\n${this.lastCompactResult || '（暂无历史摘要）'}\n\n【最新待压缩的课堂转录片段】\n${formattedTranscript}\n\n请对上述全部课堂记录进行高保真信息压缩与结构化归纳。`;

        const response = await this.llmClient.chatCompletion(
          [
            { role: 'system', content: this.compactPrompt },
            { role: 'user', content: userMessage },
          ],
          { temperature: 0.2 }
        );

        this.lastCompactResult = response.content.trim();
        this.lastCompactTimestamp = Date.now();
        this.compactedSegmentsCount += segmentsToCompact.length;

        // Empty the segments that have been compacted
        this.uncompactedSegments = this.uncompactedSegments.slice(segmentsToCompact.length);

        const compactState: CompactState = {
          summary: this.lastCompactResult,
          lastCompactTimestamp: this.lastCompactTimestamp,
          compactedSegmentsCount: this.compactedSegmentsCount,
        };

        this.emit('compact', compactState);
        return compactState;
      } catch (err: any) {
        console.error('[ScreeningEngine] Compacting error:', err?.message || err);
        return null;
      } finally {
        this.isCompacting = false;
        this.compactPromise = null;
      }
    })();

    return this.compactPromise;
  }

  /**
   * Performs an LLM screening evaluation against the active target goals.
   *
   * @param triggerType Reason for trigger ('pause' | 'timeout' | 'manual')
   * @returns ScreeningVerdict or null if already evaluating
   */
  public async evaluate(
    triggerType: 'pause' | 'timeout' | 'manual' = 'manual'
  ): Promise<ScreeningVerdict | null> {
    if (this.evalPromise) {
      return this.evalPromise;
    }
    this.isEvaluating = true;

    this.evalPromise = (async () => {
      const startTime = Date.now();
      this.lastLlmCallTime = startTime;
      this.lastLlmCallStreamSec = this.lastSpeechStreamSec;

      try {
        // If context window exceeds compact threshold, compact first
        if (this.shouldCompact()) {
          await this.compact();
        }

        const activeGoals = this.goals.filter((g) => g.enabled);
        if (activeGoals.length === 0) {
          const noGoalVerdict: ScreeningVerdict = {
            triggered: false,
            matchedGoals: [],
            confidence: 1.0,
            currentTopic: '无活跃监控目标',
            reason: '用户当前未启用任何监控目标，保持静默。',
            summary: '无活跃监控目标',
          };
          this.isEvaluating = false;
          this.evalPromise = null;
          return noGoalVerdict;
        }

        const goalsText = activeGoals
          .map((g, idx) => `[目标 ${idx + 1}] ID: "${g.id}"\n描述: ${g.text}`)
          .join('\n\n');

        const transcriptText = this.uncompactedSegments
          .map((s) => `[${this.formatTime(s)}] ${s.speaker || 'Teacher'}: ${s.text}`)
          .join('\n');

        const userPrompt = `【此前课堂压缩摘要（Compacted Summary）】
${this.lastCompactResult || '（暂无历史摘要）'}

【最新语音转录（Recent Transcript）】
${transcriptText || '（暂无新增转录）'}

【用户监控目标（Target Goals）】
${goalsText}

【判定逻辑（Goal Logic）】
${this.goalLogic}（${
          this.goalLogic === 'OR'
            ? '满足任意一个已启用的目标即触发提醒'
            : '必须所有已启用的目标全部满足才触发提醒'
        }）

【防重复判定提示】
${
  this.lastAlertedTopic
    ? `此前已就“${this.lastAlertedTopic}”发出过提醒，请勿就该同一事件或持续状态重复触发；仅在课堂发生符合监控目标描述的全新事件或阶段转换时才可触发。`
    : '此前尚未触发过提醒。'
}

请严格依据上述转录内容进行事实判定，并输出合法的单层纯 JSON 对象（禁止使用 Markdown 标记）：`;

        const response = await this.llmClient.chatCompletion(
          [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { jsonMode: true, temperature: 0.1 }
        );

        const verdict = this.parseVerdictJSON(response.content);

        const log: EvaluationLog = {
          id: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          triggerType,
          contextText: transcriptText,
          promptSent: userPrompt,
          rawResponse: response.content,
          verdict,
          durationMs: Date.now() - startTime,
          tokenUsage: response.usage,
        };

        this.emit('evaluation', log);

        if (verdict.triggered) {
          this.lastAlertedTopic = verdict.summary || verdict.currentTopic || verdict.reason;
          this.emit('alert', verdict);
        }

        return verdict;
      } catch (err: any) {
        console.error('[ScreeningEngine] Evaluation failed:', err?.message || err);

        const errorVerdict: ScreeningVerdict = {
          triggered: false,
          matchedGoals: [],
          confidence: 0,
          reason: `Evaluation failed with error: ${err?.message || String(err)}`,
          summary: 'LLM 评估异常',
        };

        const errorLog: EvaluationLog = {
          id: `eval-err-${Date.now()}`,
          timestamp: Date.now(),
          triggerType,
          contextText: '',
          promptSent: '',
          rawResponse: '',
          verdict: errorVerdict,
          durationMs: Date.now() - startTime,
        };

        this.emit('evaluation', errorLog);
        return errorVerdict;
      } finally {
        this.isEvaluating = false;
        this.evalPromise = null;
      }
    })();

    return this.evalPromise;
  }

  /**
   * Robust JSON parser for LLM verdict responses.
   */
  private parseVerdictJSON(content: string): ScreeningVerdict {
    let clean = content.trim();

    // Strip markdown code block wrapping if present
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    }

    try {
      const parsed = JSON.parse(clean);
      return {
        triggered: Boolean(parsed.triggered),
        matchedGoals: Array.isArray(parsed.matchedGoals) ? parsed.matchedGoals : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        currentTopic: parsed.currentTopic || '',
        reason: parsed.reason || '',
        summary: parsed.summary || '',
      };
    } catch {
      // Fallback: extract JSON substring via regex
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const extracted = JSON.parse(jsonMatch[0]);
          return {
            triggered: Boolean(extracted.triggered),
            matchedGoals: Array.isArray(extracted.matchedGoals) ? extracted.matchedGoals : [],
            confidence: typeof extracted.confidence === 'number' ? extracted.confidence : 0,
            currentTopic: extracted.currentTopic || '',
            reason: extracted.reason || '',
            summary: extracted.summary || '',
          };
        } catch {}
      }

      return {
        triggered: false,
        matchedGoals: [],
        confidence: 0,
        reason: `Unable to parse JSON verdict from LLM response: ${clean.slice(0, 100)}...`,
        summary: '解析判定结果失败',
      };
    }
  }

  /**
   * Formats a segment timestamp to [MM:SS].
   */
  private formatTime(seg: STTSegment): string {
    let totalSec = 0;
    if (typeof seg.startTime === 'number') {
      totalSec =
        seg.startTime > 1000000
          ? Math.max(0, Math.floor((seg.startTime - this.sessionStartTime) / 1000))
          : Math.floor(seg.startTime);
    } else if (typeof seg.timestamp === 'number') {
      totalSec = Math.max(0, Math.floor((seg.timestamp - this.sessionStartTime) / 1000));
    }

    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  // ==========================================
  // Public Accessors & Configuration Setters
  // ==========================================

  public getUncompactedSegments(): STTSegment[] {
    return [...this.uncompactedSegments];
  }

  public getLastCompactResult(): string {
    return this.lastCompactResult;
  }

  public getCompactState(): CompactState {
    return {
      summary: this.lastCompactResult,
      lastCompactTimestamp: this.lastCompactTimestamp,
      compactedSegmentsCount: this.compactedSegmentsCount,
    };
  }

  public getGoals(): GoalItem[] {
    return [...this.goals];
  }

  public async triggerManualEvaluation(reason?: string): Promise<ScreeningVerdict | null> {
    return this.evaluate('manual');
  }

  public setUserGoals(goals: GoalItem[], logic?: GoalLogic): void {
    this.setGoals(goals);
    if (logic) this.setGoalLogic(logic);
  }

  public setThresholds(thresholds: any): void {
    this.updateThresholds(thresholds);
  }

  public setGoals(goals: GoalItem[]): void {
    this.goals = [...goals];
    if (this.configStore) {
      this.configStore.setGoals(goals);
    }
  }

  public setGoalLogic(logic: GoalLogic): void {
    this.goalLogic = logic;
    if (this.configStore) {
      this.configStore.setGoalLogic(logic);
    }
  }

  public updatePrompts(prompts: { systemPrompt?: string; compactPrompt?: string }): void {
    if (prompts.systemPrompt) this.systemPrompt = prompts.systemPrompt;
    if (prompts.compactPrompt) this.compactPrompt = prompts.compactPrompt;
    if (this.configStore) {
      this.configStore.updatePrompts({
        systemPrompt: this.systemPrompt,
        compactPrompt: this.compactPrompt,
      });
    }
  }

  public updateThresholds(thresholds: {
    pauseThresholdSec?: number;
    minIntervalSec?: number;
    maxIntervalSec?: number;
  }): void {
    if (thresholds.pauseThresholdSec !== undefined) {
      this.pauseThresholdSec = thresholds.pauseThresholdSec;
    }
    if (thresholds.minIntervalSec !== undefined) {
      this.minIntervalSec = thresholds.minIntervalSec;
    }
    if (thresholds.maxIntervalSec !== undefined) {
      this.maxIntervalSec = thresholds.maxIntervalSec;
    }
    if (this.configStore) {
      this.configStore.updateThresholds({
        pauseThresholdSec: this.pauseThresholdSec,
        minIntervalSec: this.minIntervalSec,
        maxIntervalSec: this.maxIntervalSec,
      });
    }
  }

  public clearHistory(): void {
    this.uncompactedSegments = [];
    this.lastCompactResult = '';
    this.lastLlmCallTime = 0;
    this.lastSpeechTime = 0;
    this.compactedSegmentsCount = 0;
    this.lastCompactTimestamp = 0;
  }

  public getStats(): {
    uncompactedCount: number;
    compactedCount: number;
    lastSpeechTime: number;
    lastLlmCallTime: number;
    isRunning: boolean;
    isEvaluating: boolean;
    isCompacting: boolean;
    contextTokens: number;
  } {
    return {
      uncompactedCount: this.uncompactedSegments.length,
      compactedCount: this.compactedSegmentsCount,
      lastSpeechTime: this.lastSpeechTime,
      lastLlmCallTime: this.lastLlmCallTime,
      isRunning: this.isRunning,
      isEvaluating: this.isEvaluating,
      isCompacting: this.isCompacting,
      contextTokens: this.getCurrentContextTokens(),
    };
  }
}
