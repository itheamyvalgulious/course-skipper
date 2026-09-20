import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AIBackendType } from '../provider/types';

export interface SkipperConfig {
  backendType: AIBackendType;
  apiKey?: string;
  vertexProject?: string;
  vertexLocation?: string;
  vertexApiKey?: string;
  model: string;
  userPrompt: string;
  lastBrowserUrl?: string;
  muteLocalAudio: boolean;
}

export const DEFAULT_CONFIG: SkipperConfig = {
  backendType: 'mock',
  apiKey: '',
  vertexProject: '',
  vertexLocation: 'us-central1',
  vertexApiKey: '',
  model: 'gemini-3.8-live',
  userPrompt: '当老师讲完当前知识点或证明时叫我',
  lastBrowserUrl: '',
  muteLocalAudio: true,
};

export class ConfigStore {
  private configPath: string;
  private config: SkipperConfig;

  constructor(customPath?: string) {
    if (customPath) {
      this.configPath = customPath;
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
    }

    this.config = this.loadConfig();
  }

  public getFilePath(): string {
    return this.configPath;
  }

  public getConfig(): SkipperConfig {
    return { ...this.config };
  }

  public get<K extends keyof SkipperConfig>(key: K): SkipperConfig[K] {
    return this.config[key];
  }

  public updateConfig(partial: Partial<SkipperConfig>): SkipperConfig {
    this.config = {
      ...this.config,
      ...partial,
    };
    this.saveConfig();
    return this.getConfig();
  }

  public set<K extends keyof SkipperConfig>(key: K, value: SkipperConfig[K]): void {
    this.config[key] = value;
    this.saveConfig();
  }

  public loadConfig(): SkipperConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
        };
      }
    } catch (err: any) {
      console.warn('[ConfigStore] Error loading config, using defaults:', err?.message);
    }
    return { ...DEFAULT_CONFIG };
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
