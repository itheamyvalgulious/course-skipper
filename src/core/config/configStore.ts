import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AIBackendType } from '../provider/types';
import { GoalItem, GoalLogic } from '../llm/types';
import {
  DEFAULT_GOALS,
  DEFAULT_GOAL_LOGIC,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_COMPACT_THRESHOLD_RATIO,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_COMPACT_PROMPT,
  PAUSE_THRESHOLD_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  DEFAULT_STT_PROVIDER,
  DEFAULT_STT_LANGUAGE_CODE,
  DEFAULT_STT_ROLLING_WINDOW_SEC,
} from './constants';

export { GoalItem, GoalLogic };

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxContextTokens: number;
  compactRatio: number;
}

export interface STTConfig {
  provider: 'google' | 'cpu' | 'funasr' | 'mock';
  googleApiKey?: string;
  languageCode: string;
  rollingWindowSec: number;
  funasrModelDir?: string;
  funasrLanguage?: string;
  funasrHotwords?: string;
}

export interface PromptsConfig {
  systemPrompt: string;
  compactPrompt: string;
}

export interface ThresholdsConfig {
  pauseThresholdSec: number;
  minIntervalSec: number;
  maxIntervalSec: number;
}

export interface SkipperConfig {
  // Legacy / backward-compatible properties
  backendType?: AIBackendType;
  apiKey?: string;
  vertexProject?: string;
  vertexLocation?: string;
  vertexApiKey?: string;
  model?: string;
  userPrompt?: string;

  // Modern structured properties
  goals: GoalItem[];
  goalLogic: GoalLogic;
  llm: LLMConfig;
  stt: STTConfig;
  prompts: PromptsConfig;
  thresholds: ThresholdsConfig;
  lastBrowserUrl: string;
  muteLocalAudio: boolean;
}

export const DEFAULT_CONFIG: SkipperConfig = {
  backendType: 'mock',
  apiKey: DEFAULT_LLM_API_KEY,
  model: 'gemini-3.8-live',
  userPrompt: '当老师讲完当前知识点或证明时叫我',

  goals: [...DEFAULT_GOALS],
  goalLogic: DEFAULT_GOAL_LOGIC,
  llm: {
    baseUrl: DEFAULT_LLM_BASE_URL,
    apiKey: DEFAULT_LLM_API_KEY,
    model: DEFAULT_LLM_MODEL,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    compactRatio: DEFAULT_COMPACT_THRESHOLD_RATIO,
  },
  stt: {
    provider: DEFAULT_STT_PROVIDER,
    googleApiKey: '',
    languageCode: DEFAULT_STT_LANGUAGE_CODE,
    rollingWindowSec: DEFAULT_STT_ROLLING_WINDOW_SEC,
  },
  prompts: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    compactPrompt: DEFAULT_COMPACT_PROMPT,
  },
  thresholds: {
    pauseThresholdSec: PAUSE_THRESHOLD_SECONDS,
    minIntervalSec: MIN_INTERVAL_SECONDS,
    maxIntervalSec: MAX_INTERVAL_SECONDS,
  },
  lastBrowserUrl: '',
  muteLocalAudio: true,
};

export class ConfigStore {
  private configPath: string;
  private promptsPath: string;
  private constantsPath: string;
  private config: SkipperConfig;

  constructor(customPath?: string) {
    let baseDir = '';
    if (customPath) {
      this.configPath = customPath;
      baseDir = path.dirname(customPath);
    } else {
      let userDataDir = '';
      try {
        if (app && typeof app.getPath === 'function') {
          userDataDir = app.getPath('userData');
        }
      } catch {}

      if (!userDataDir) {
        userDataDir = path.join(process.cwd(), '.skipper-data');
      }

      try {
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
        }
      } catch (err: any) {
        console.warn('[ConfigStore] Failed to ensure userData dir:', err?.message);
      }

      this.configPath = path.join(userDataDir, 'skipper-config.json');
      baseDir = userDataDir;
    }

    this.promptsPath = path.join(baseDir, 'skipper-prompts.json');
    this.constantsPath = path.join(baseDir, 'skipper-constants.json');
    this.config = this.loadConfig();
  }

  public getFilePath(): string {
    return this.configPath;
  }

  public getPromptsPath(): string {
    return this.promptsPath;
  }

  public getConstantsPath(): string {
    return this.constantsPath;
  }

  public getConfig(): SkipperConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  public get<K extends keyof SkipperConfig>(key: K): SkipperConfig[K] {
    return this.config[key];
  }

  public updateConfig(partial: Partial<SkipperConfig>): SkipperConfig {
    this.config = {
      ...this.config,
      ...partial,
      llm: partial.llm ? { ...this.config.llm, ...partial.llm } : this.config.llm,
      stt: partial.stt ? { ...this.config.stt, ...partial.stt } : this.config.stt,
      prompts: partial.prompts ? { ...this.config.prompts, ...partial.prompts } : this.config.prompts,
      thresholds: partial.thresholds ? { ...this.config.thresholds, ...partial.thresholds } : this.config.thresholds,
      goals: partial.goals ? [...partial.goals] : this.config.goals,
    };

    // Synchronize top-level legacy fields if nested llm changed
    if (partial.llm?.apiKey !== undefined) {
      this.config.apiKey = partial.llm.apiKey;
    } else if (partial.apiKey !== undefined) {
      this.config.llm.apiKey = partial.apiKey;
    }

    if (partial.llm?.model !== undefined) {
      this.config.model = partial.llm.model;
    } else if (partial.model !== undefined) {
      this.config.llm.model = partial.model;
    }

    this.saveConfig();
    return this.getConfig();
  }

  public set<K extends keyof SkipperConfig>(key: K, value: SkipperConfig[K]): void {
    this.config[key] = value;
    if (key === 'apiKey' && typeof value === 'string') {
      this.config.llm.apiKey = value;
    } else if (key === 'model' && typeof value === 'string') {
      this.config.llm.model = value;
    }
    this.saveConfig();
  }

  public updateLLMConfig(partial: Partial<LLMConfig>): LLMConfig {
    this.config.llm = {
      ...this.config.llm,
      ...partial,
    };
    if (partial.apiKey !== undefined) {
      this.config.apiKey = partial.apiKey;
    }
    if (partial.model !== undefined) {
      this.config.model = partial.model;
    }
    this.saveConfig();
    return { ...this.config.llm };
  }

  public updateSTTConfig(partial: Partial<STTConfig>): STTConfig {
    this.config.stt = {
      ...this.config.stt,
      ...partial,
    };
    this.saveConfig();
    return { ...this.config.stt };
  }

  public updateThresholds(partial: Partial<ThresholdsConfig>): ThresholdsConfig {
    this.config.thresholds = {
      ...this.config.thresholds,
      ...partial,
    };
    this.saveConfig();
    return { ...this.config.thresholds };
  }

  public updatePrompts(partial: Partial<PromptsConfig>): PromptsConfig {
    this.config.prompts = {
      ...this.config.prompts,
      ...partial,
    };
    this.saveConfig();
    return { ...this.config.prompts };
  }

  public getPrompts(): PromptsConfig {
    return { ...this.config.prompts };
  }

  public savePrompts(prompts: Partial<PromptsConfig>): boolean {
    this.config.prompts = {
      ...this.config.prompts,
      ...prompts,
    };
    try {
      const dir = path.dirname(this.promptsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.promptsPath, JSON.stringify(this.config.prompts, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[ConfigStore] Error saving prompts file:', err?.message);
    }
    this.saveConfig();
    return true;
  }

  public getConstants(): ThresholdsConfig & { compactRatio: number; maxContextTokens: number } {
    return {
      ...this.config.thresholds,
      compactRatio: this.config.llm.compactRatio,
      maxContextTokens: this.config.llm.maxContextTokens,
    };
  }

  public saveConstants(constants: any): boolean {
    if (constants.pauseThresholdSec !== undefined) {
      this.config.thresholds.pauseThresholdSec = Number(constants.pauseThresholdSec);
    }
    if (constants.minIntervalSec !== undefined) {
      this.config.thresholds.minIntervalSec = Number(constants.minIntervalSec);
    }
    if (constants.maxIntervalSec !== undefined) {
      this.config.thresholds.maxIntervalSec = Number(constants.maxIntervalSec);
    }
    if (constants.compactRatio !== undefined) {
      this.config.llm.compactRatio = Number(constants.compactRatio);
    }
    if (constants.maxContextTokens !== undefined) {
      this.config.llm.maxContextTokens = Number(constants.maxContextTokens);
    }
    try {
      const dir = path.dirname(this.constantsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const constObj = {
        pauseThresholdSec: this.config.thresholds.pauseThresholdSec,
        minIntervalSec: this.config.thresholds.minIntervalSec,
        maxIntervalSec: this.config.thresholds.maxIntervalSec,
        compactRatio: this.config.llm.compactRatio,
        maxContextTokens: this.config.llm.maxContextTokens,
      };
      fs.writeFileSync(this.constantsPath, JSON.stringify(constObj, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[ConfigStore] Error saving constants file:', err?.message);
    }
    this.saveConfig();
    return true;
  }

  public getGoals(): GoalItem[] {
    return [...this.config.goals];
  }

  public getGoalLogic(): GoalLogic {
    return this.config.goalLogic;
  }

  public getLLMConfig(): LLMConfig {
    return { ...this.config.llm };
  }

  public getSTTConfig(): STTConfig {
    return { ...this.config.stt };
  }

  public setGoals(goals: GoalItem[]): void {
    this.config.goals = [...goals];
    this.saveConfig();
  }

  public addGoal(text: string, enabled: boolean = true): GoalItem {
    const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newGoal: GoalItem = { id, text, enabled };
    this.config.goals.push(newGoal);
    this.saveConfig();
    return newGoal;
  }

  public updateGoal(id: string, partial: Partial<Omit<GoalItem, 'id'>>): boolean {
    const index = this.config.goals.findIndex((g) => g.id === id);
    if (index === -1) return false;
    this.config.goals[index] = {
      ...this.config.goals[index],
      ...partial,
    };
    this.saveConfig();
    return true;
  }

  public removeGoal(id: string): boolean {
    const index = this.config.goals.findIndex((g) => g.id === id);
    if (index === -1) return false;
    this.config.goals.splice(index, 1);
    this.saveConfig();
    return true;
  }

  public setGoalLogic(logic: GoalLogic): void {
    this.config.goalLogic = logic;
    this.saveConfig();
  }

  public resetToDefaults(): SkipperConfig {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.saveConfig();
    return this.getConfig();
  }

  public loadConfig(): SkipperConfig {
    try {
      let merged: SkipperConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);

        merged = {
          ...DEFAULT_CONFIG,
          ...parsed,
          llm: {
            ...DEFAULT_CONFIG.llm,
            ...(parsed.llm || {}),
          },
          stt: {
            ...DEFAULT_CONFIG.stt,
            ...(parsed.stt || {}),
          },
          prompts: {
            ...DEFAULT_CONFIG.prompts,
            ...(parsed.prompts || {}),
          },
          thresholds: {
            ...DEFAULT_CONFIG.thresholds,
            ...(parsed.thresholds || {}),
          },
          goals: Array.isArray(parsed.goals) ? parsed.goals : [...DEFAULT_CONFIG.goals],
          goalLogic: parsed.goalLogic || DEFAULT_CONFIG.goalLogic,
        };
      }

      // Check independent prompts file if present
      if (fs.existsSync(this.promptsPath)) {
        try {
          const rawPrompts = fs.readFileSync(this.promptsPath, 'utf-8');
          const parsedPrompts = JSON.parse(rawPrompts);
          merged.prompts = { ...merged.prompts, ...parsedPrompts };
        } catch {}
      }

      // Check independent constants file if present
      if (fs.existsSync(this.constantsPath)) {
        try {
          const rawConstants = fs.readFileSync(this.constantsPath, 'utf-8');
          const parsedConstants = JSON.parse(rawConstants);
          if (parsedConstants.pauseThresholdSec !== undefined) merged.thresholds.pauseThresholdSec = Number(parsedConstants.pauseThresholdSec);
          if (parsedConstants.minIntervalSec !== undefined) merged.thresholds.minIntervalSec = Number(parsedConstants.minIntervalSec);
          if (parsedConstants.maxIntervalSec !== undefined) merged.thresholds.maxIntervalSec = Number(parsedConstants.maxIntervalSec);
          if (parsedConstants.compactRatio !== undefined) merged.llm.compactRatio = Number(parsedConstants.compactRatio);
          if (parsedConstants.maxContextTokens !== undefined) merged.llm.maxContextTokens = Number(parsedConstants.maxContextTokens);
        } catch {}
      }

      return merged;
    } catch (err: any) {
      console.warn('[ConfigStore] Error loading config, using defaults:', err?.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  public saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err: any) {
      console.error('[ConfigStore] Error saving config:', err?.message);
    }
  }
}
