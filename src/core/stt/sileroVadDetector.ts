/**
 * Skipper - Silero VAD Neural Detector
 * Uses sherpa-onnx-vad.exe and silero_vad.onnx for deep learning-based Voice Activity Detection.
 * Accurately filters out physical noise (e.g. chalkboard clicks, desk shuffling, breath)
 * to prevent Speech-LLM hallucinations and degenerate repetition loops.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { BaseSTTProvider } from './baseSTTProvider';

export interface SileroVadConfig {
  vadBinPath?: string;
  vadModelPath?: string;
  threshold?: number;
  minSilenceDuration?: number;
  minSpeechDuration?: number;
  maxSpeechDuration?: number;
}

export interface VadDetectionResult {
  hasSpeech: boolean;
  totalSpeechSec: number;
  intervals: Array<{ start: number; end: number }>;
}

export class SileroVadDetector {
  private readonly vadBinPath: string;
  private readonly vadModelPath: string;
  private readonly threshold: number;
  private readonly minSilenceDuration: number;
  private readonly minSpeechDuration: number;
  private readonly maxSpeechDuration: number;
  private readonly sampleRate: number = 16000;

  constructor(config?: SileroVadConfig) {
    const rootDir = process.cwd();
    const exeExt = process.platform === 'win32' ? '.exe' : '';
    this.vadBinPath =
      config?.vadBinPath ||
      path.join(rootDir, 'resources', 'bin', 'sherpa', `sherpa-onnx-vad${exeExt}`);
    this.vadModelPath =
      config?.vadModelPath ||
      path.join(rootDir, 'resources', 'models', 'silero-vad', 'silero_vad.onnx');
    this.threshold = config?.threshold ?? 0.5;
    this.minSilenceDuration = config?.minSilenceDuration ?? 0.5;
    this.minSpeechDuration = config?.minSpeechDuration ?? 0.3;
    this.maxSpeechDuration = config?.maxSpeechDuration ?? 20.0;

    this.verifyModelPresence();
  }

  /**
   * Verifies that the Silero-VAD binary and model exist.
   * Strict Fail-Fast policy: throws immediately if files are missing.
   */
  public verifyModelPresence(): void {
    if (!fs.existsSync(this.vadBinPath)) {
      throw new Error(
        `[SileroVadDetector] sherpa-onnx-vad binary not found at: "${this.vadBinPath}".`
      );
    }
    if (!fs.existsSync(this.vadModelPath)) {
      throw new Error(
        `[SileroVadDetector] silero_vad.onnx model missing at: "${this.vadModelPath}". Please run "npm run download:vad" to download.`
      );
    }
  }

  public getModelPath(): string {
    return this.vadModelPath;
  }

  public getBinPath(): string {
    return this.vadBinPath;
  }

  /**
   * Evaluates a PCM buffer (16kHz 16-bit mono) and returns voice activity detection results.
   *
   * @param pcm 16kHz 16-bit mono PCM buffer
   * @returns VadDetectionResult
   */
  public async detectSpeech(pcm: Buffer): Promise<VadDetectionResult> {
    if (!pcm || pcm.length < 3200) {
      // Less than 100ms
      return { hasSpeech: false, totalSpeechSec: 0, intervals: [] };
    }

    const tempId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tempInWav = path.join(os.tmpdir(), `skipper_vad_in_${tempId}.wav`);
    const tempOutWav = path.join(os.tmpdir(), `skipper_vad_out_${tempId}.wav`);

    try {
      const wavBuffer = BaseSTTProvider.pcmToWav(pcm, this.sampleRate, 1, 16);
      fs.writeFileSync(tempInWav, wavBuffer);

      const args = [
        `--silero-vad-model=${this.vadModelPath}`,
        `--silero-vad-threshold=${this.threshold}`,
        `--silero-vad-min-silence-duration=${this.minSilenceDuration}`,
        `--silero-vad-min-speech-duration=${this.minSpeechDuration}`,
        `--silero-vad-max-speech-duration=${this.maxSpeechDuration}`,
        '--print-args=false',
        tempInWav,
        tempOutWav,
      ];

      const combinedOutput = await new Promise<string>((resolve, reject) => {
        execFile(
          this.vadBinPath,
          args,
          { timeout: 10000, encoding: 'utf-8' },
          (err, out, stderr) => {
            if (err) {
              return reject(
                new Error(`[SileroVadDetector] Execution failed: ${err.message}. Stderr: ${stderr}`)
              );
            }
            resolve((out || '') + '\n' + (stderr || ''));
          }
        );
      });

      // Parse intervals from output/stderr (e.g. "0.166 -- 1.004")
      const intervals: Array<{ start: number; end: number }> = [];
      const lines = combinedOutput.split(/\r?\n/);
      const intervalRegex = /^\s*(\d+(?:\.\d+)?)\s*--\s*(\d+(?:\.\d+)?)\s*$/;

      for (const line of lines) {
        const match = line.match(intervalRegex);
        if (match) {
          const start = parseFloat(match[1]);
          const end = parseFloat(match[2]);
          if (!isNaN(start) && !isNaN(end) && end > start) {
            intervals.push({ start, end });
          }
        }
      }

      // Also verify output wav audio content size
      let outAudioBytes = 0;
      if (fs.existsSync(tempOutWav)) {
        const outStat = fs.statSync(tempOutWav);
        if (outStat.size > 44) {
          outAudioBytes = outStat.size - 44;
        }
      }

      const totalSpeechSec = intervals.reduce((acc, cur) => acc + (cur.end - cur.start), 0);
      const hasSpeech = (totalSpeechSec >= this.minSpeechDuration || outAudioBytes >= 3200) && outAudioBytes > 0;

      return {
        hasSpeech,
        totalSpeechSec,
        intervals,
      };
    } finally {
      try {
        if (fs.existsSync(tempInWav)) fs.unlinkSync(tempInWav);
      } catch {}
      try {
        if (fs.existsSync(tempOutWav)) fs.unlinkSync(tempOutWav);
      } catch {}
    }
  }
}
