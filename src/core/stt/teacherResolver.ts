import { EventEmitter } from 'events';

export interface SpeakerTrackInfo {
  id: string; // e.g. "Speaker 0", "Speaker 1"
  resolvedRole: string; // e.g. "Teacher" or "Speaker 1"
  isTeacher: boolean;
  totalDurationSec: number;
  utteranceCount: number;
  recentUtterances: string[]; // up to 5 recent utterances
  lastSpokeSec: number;
}

export interface TeacherResolutionVerdict {
  teacherSpeakerId: string;
  confidence: number;
  reason: string;
}

export interface TeacherResolverEvents {
  'teacherChanged': (newTeacherId: string, isManual: boolean, reason?: string) => void;
  'tracksUpdated': (tracks: SpeakerTrackInfo[]) => void;
}

/**
 * TeacherResolver manages speaker tracks discovered by Diarization (Sherpa-onnx),
 * provides real-time track tracking for the UI, enables manual user designation,
 * and runs periodic 3-minute LLM inference to automatically deduce who the teacher is.
 */
export class TeacherResolver extends EventEmitter {
  private manualTeacherId: string | null = null;
  private inferredTeacherId: string | null = null;
  private lastInferenceTimeSec: number = 0;
  private readonly inferenceIntervalSec: number = 180; // 3 minutes
  private tracks: Map<string, SpeakerTrackInfo> = new Map();
  private isInferring: boolean = false;

  constructor(initialManualTeacherId?: string | null) {
    super();
    if (initialManualTeacherId) {
      this.manualTeacherId = initialManualTeacherId;
    }
  }

  /**
   * Records a detected speech utterance for a given speaker ID.
   */
  public recordUtterance(
    speakerId: string,
    text: string,
    durationSec: number,
    streamTimestampSec: number
  ): void {
    if (!speakerId) return;

    const cleanId = speakerId.trim();
    let track = this.tracks.get(cleanId);

    if (!track) {
      track = {
        id: cleanId,
        resolvedRole: cleanId,
        isTeacher: false,
        totalDurationSec: 0,
        utteranceCount: 0,
        recentUtterances: [],
        lastSpokeSec: streamTimestampSec,
      };
      this.tracks.set(cleanId, track);

      // If this is the very first and only speaker, default to teacher initially
      if (this.tracks.size === 1 && !this.manualTeacherId && !this.inferredTeacherId) {
        this.inferredTeacherId = cleanId;
      }
    }

    track.totalDurationSec += Math.max(0, durationSec);
    track.utteranceCount += 1;
    track.lastSpokeSec = streamTimestampSec;

    if (text && text.trim()) {
      track.recentUtterances.push(text.trim());
      if (track.recentUtterances.length > 6) {
        track.recentUtterances.shift();
      }
    }

    this.updateTrackRoles();
    this.emit('tracksUpdated', this.getSpeakerTracks());
  }

  /**
   * Returns the mapped role (e.g. 'Teacher' or 'Speaker 1') for a given raw speaker ID.
   */
  public getResolvedSpeaker(rawSpeakerId: string): string {
    if (!rawSpeakerId) return 'Teacher';
    const cleanId = rawSpeakerId.trim();
    const activeTeacher = this.getActiveTeacherId();

    if (activeTeacher && cleanId.toLowerCase() === activeTeacher.toLowerCase()) {
      return 'Teacher';
    }

    return cleanId;
  }

  /**
   * Sets manual override for the teacher identity. Pass null for automatic resolution.
   */
  public setManualTeacher(speakerId: string | null): void {
    this.manualTeacherId = speakerId ? speakerId.trim() : null;
    this.updateTrackRoles();
    const activeTeacher = this.getActiveTeacherId();
    if (activeTeacher) {
      this.emit('teacherChanged', activeTeacher, true, 'User manually designated');
    }
    this.emit('tracksUpdated', this.getSpeakerTracks());
  }

  public getManualTeacher(): string | null {
    return this.manualTeacherId;
  }

  public getInferredTeacher(): string | null {
    return this.inferredTeacherId;
  }

  public getActiveTeacherId(): string | null {
    return this.manualTeacherId || this.inferredTeacherId || (this.tracks.size === 1 ? Array.from(this.tracks.keys())[0] : null);
  }

  /**
   * Returns all known speaker tracks sorted by total speech duration descending.
   */
  public getSpeakerTracks(): SpeakerTrackInfo[] {
    const activeTeacher = this.getActiveTeacherId();
    const result: SpeakerTrackInfo[] = [];

    for (const track of this.tracks.values()) {
      const isTeacher = !!activeTeacher && track.id.toLowerCase() === activeTeacher.toLowerCase();
      result.push({
        ...track,
        isTeacher,
        resolvedRole: isTeacher ? 'Teacher' : track.id,
      });
    }

    return result.sort((a, b) => b.totalDurationSec - a.totalDurationSec);
  }

  /**
   * Periodic 3-minute automatic teacher inference using LLM.
   * If user has set a manual teacher, automatic inference is skipped.
   */
  public async maybeInferTeacherViaLLM(
    llmClient: {
      chatCompletion?: (messages: any[], options?: any) => Promise<{ content: string }>;
      complete?: (options: any) => Promise<{ content: string }>;
    },
    currentStreamSec: number
  ): Promise<string | null> {
    // 1. Skip if manually designated
    if (this.manualTeacherId) {
      return this.manualTeacherId;
    }

    // 2. Skip if already inferring or not enough tracks
    if (this.isInferring || this.tracks.size <= 1) {
      return this.getActiveTeacherId();
    }

    // 3. Check 3-minute interval
    const timeSinceLastInference = currentStreamSec - this.lastInferenceTimeSec;
    if (this.inferredTeacherId && timeSinceLastInference < this.inferenceIntervalSec) {
      return this.inferredTeacherId;
    }

    // 4. Build prompt with sample utterances
    const trackSummaries: string[] = [];
    for (const track of this.tracks.values()) {
      const samples = track.recentUtterances.length > 0
        ? track.recentUtterances.map((u) => `  - "${u}"`).join('\n')
        : '  (暂无典型发言)';
      trackSummaries.push(
        `【候选说话人: ${track.id}】\n总发言时长: ${track.totalDurationSec.toFixed(1)}秒, 发言次数: ${track.utteranceCount}\n典型发言记录:\n${samples}`
      );
    }

    const systemPrompt = `你是一名课堂智能语音分析助手。
当前实时声纹分离（Diarization）系统在课堂中检测到了多个发言者音轨，需要你根据其发言内容判定谁是主讲老师（Teacher）。
老师特征：主导课堂进度、讲解数学/定理/概念、板书、提问引导、组织练习、发言时长通常占据主导。
学生特征：简短回答、提问、回应"听明白了/没有"、提问迟疑。

请务必仅返回严格的 JSON 格式，不得包含任何 Markdown 或解释文本：
{
  "teacherSpeakerId": "<候选人完整名称，必须严格匹配提供的候选人ID>",
  "confidence": <0.0到1.0的浮点数>,
  "reason": "<简明判定原因>"
}`;

    const userPrompt = `以下为当前课堂识别到的全部说话人音轨及其近期真实发言：\n\n${trackSummaries.join('\n\n')}\n\n请判定哪一个说话人是主讲老师（Teacher）。`;

    this.isInferring = true;
    try {
      console.log(`[TeacherResolver] Running 3-minute LLM teacher inference (currentStream: ${currentStreamSec.toFixed(1)}s)...`);
      let content = '';
      if (typeof (llmClient as any).chatCompletion === 'function') {
        const res = await (llmClient as any).chatCompletion(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { jsonMode: true, temperature: 0.1 }
        );
        content = res.content;
      } else if (typeof (llmClient as any).complete === 'function') {
        const res = await (llmClient as any).complete({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          jsonMode: true,
        });
        content = res.content;
      }

      const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const parsed: TeacherResolutionVerdict = JSON.parse(raw);

      if (parsed && parsed.teacherSpeakerId && this.tracks.has(parsed.teacherSpeakerId)) {
        const previousTeacher = this.inferredTeacherId;
        this.inferredTeacherId = parsed.teacherSpeakerId;
        this.lastInferenceTimeSec = currentStreamSec;

        console.log(
          `[TeacherResolver] ✓ LLM designated teacher: [${this.inferredTeacherId}] (confidence: ${parsed.confidence}, reason: ${parsed.reason})`
        );

        if (previousTeacher !== this.inferredTeacherId) {
          this.emit('teacherChanged', this.inferredTeacherId, false, parsed.reason);
        }
        this.updateTrackRoles();
        this.emit('tracksUpdated', this.getSpeakerTracks());
      }
    } catch (err: any) {
      console.warn('[TeacherResolver] LLM teacher inference failed:', err?.message || err);
    } finally {
      this.isInferring = false;
    }

    return this.getActiveTeacherId();
  }

  private updateTrackRoles(): void {
    const activeTeacher = this.getActiveTeacherId();
    for (const track of this.tracks.values()) {
      track.isTeacher = !!activeTeacher && track.id.toLowerCase() === activeTeacher.toLowerCase();
      track.resolvedRole = track.isTeacher ? 'Teacher' : track.id;
    }
  }

  public reset(): void {
    this.tracks.clear();
    this.inferredTeacherId = null;
    this.lastInferenceTimeSec = 0;
    this.isInferring = false;
  }
}
