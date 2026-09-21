import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createSTTProvider, ISTTProvider, STTSegment } from '../core/stt';
import { ScreeningEngine, LLMClient, ScreeningVerdict, EvaluationLog } from '../core/llm';
import { GoalItem, GoalLogic } from '../core/llm/types';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
  DEFAULT_GOAL_LOGIC,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_COMPACT_PROMPT,
  PAUSE_THRESHOLD_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
} from '../core/config/constants';

interface CliOptions {
  file: string;
  benchmark?: string;
  goalsFile?: string;
  goals?: string[];
  goalLogic?: GoalLogic;
  sttProvider: 'google' | 'cpu' | 'mock' | 'funasr';
  apiKey: string;
  baseUrl: string;
  model: string;
  outputDir: string;
  toleranceSec: number;
  fastMode: boolean;
  whisperModelSize?: 'small' | 'medium';
  sherpaEmbeddingModelType?: 'campplus' | 'eres2netv2';
  manualTeacherId?: string;
  enableNativeWhisper?: boolean;
}

interface BenchmarkItem {
  lineIndex: number;
  raw: string;
  seconds: number;
  matchedTrigger?: {
    timestamp: number;
    seconds: number;
    verdict: ScreeningVerdict;
    latencySec: number;
  };
}

function parseTimecode(str: string): number | null {
  const parts = str.trim().split(':');
  if (parts.length === 2) {
    const mins = parseInt(parts[0], 10);
    const secs = parseFloat(parts[1]);
    if (!isNaN(mins) && !isNaN(secs)) {
      return mins * 60 + secs;
    }
  } else if (parts.length === 3) {
    const hrs = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    const secs = parseFloat(parts[2]);
    if (!isNaN(hrs) && !isNaN(mins) && !isNaN(secs)) {
      return hrs * 3600 + mins * 60 + secs;
    }
  }
  const numeric = parseFloat(str);
  return isNaN(numeric) ? null : numeric;
}

function formatSeconds(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    file: 'test-assets/sample_10min.mp3',
    benchmark: 'test-assets/benchmark_10min.txt',
    sttProvider: 'cpu',
    apiKey: DEFAULT_LLM_API_KEY,
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: DEFAULT_LLM_MODEL,
    outputDir: 'benchmark-results',
    toleranceSec: 25.0,
    fastMode: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' || arg === '-f') {
      options.file = args[++i];
    } else if (arg === '--benchmark' || arg === '-b') {
      options.benchmark = args[++i];
    } else if (arg === '--goals-file') {
      options.goalsFile = args[++i];
    } else if (arg === '--goal' || arg === '-g') {
      if (!options.goals) options.goals = [];
      options.goals.push(args[++i]);
    } else if (arg === '--logic') {
      options.goalLogic = (args[++i].toUpperCase() === 'AND' ? 'AND' : 'OR') as GoalLogic;
    } else if (arg === '--stt') {
      options.sttProvider = args[++i] as any;
    } else if (arg === '--key') {
      options.apiKey = args[++i];
    } else if (arg === '--base-url') {
      options.baseUrl = args[++i];
    } else if (arg === '--model') {
      options.model = args[++i];
    } else if (arg === '--output' || arg === '-o') {
      options.outputDir = args[++i];
    } else if (arg === '--whisper-model') {
      options.whisperModelSize = args[++i] as any;
    } else if (arg === '--sherpa-model') {
      options.sherpaEmbeddingModelType = args[++i] as any;
    } else if (arg === '--manual-teacher') {
      options.manualTeacherId = args[++i];
    } else if (arg === '--native-whisper') {
      options.enableNativeWhisper = true;
    } else if (arg === '--tolerance') {
      options.toleranceSec = parseFloat(args[++i]);
    } else if (arg === '--realtime') {
      options.fastMode = false;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`
Skipper CLI - 命令行音视频评测工具 (STT -> LLM 筛选 -> Benchmark 比对)

使用方法:
  node dist/cli/index.js [选项]

选项:
  --file, -f <path>        指定测试音频/视频文件路径 (默认: test-assets/sample_10min.mp3)
  --benchmark, -b <path>   指定评测基准文件路径 (每行格式 MM:SS, 默认: test-assets/benchmark_10min.txt)
  --goals-file <path>      指定监控目标配置文件 JSON 路径 (默认: test-assets/benchmark_goals.json)
  --goal, -g <text>        动态指定单条监控目标 (可多次指定)
  --logic <AND|OR>         监控目标判定逻辑 (默认: OR)
  --stt <provider>         选择 STT 引擎: 'funasr' | 'cpu' | 'google' | 'mock' (默认: 'cpu')
  --whisper-model <size>   选择 Whisper 模型大小: 'small' | 'medium' (默认: 'small')
  --sherpa-model <type>    选择 Sherpa 声纹模型: 'campplus' | 'eres2netv2' (默认: 'campplus')
  --manual-teacher <id>    手动指定主讲老师角色 (如 'speaker_00')
  --native-whisper         强制启用本地原生 Whisper.cpp 引擎识别
  --key <apiKey>           OpenAI/Gemini API Key
  --base-url <url>         LLM 服务 Base URL (默认: https://api.deepseek.com)
  --model <model>          LLM 模型名称 (默认: deepseek-v4-flash)
  --output, -o <dir>       评测结果输出目录 (默认: benchmark-results)
  --tolerance <seconds>    Benchmark 匹配容差秒数 (默认: 25.0s)
  --realtime               以真实播放速率模拟 (默认以高速直接分析)
  --help, -h               显示帮助说明
  `);
}

async function extractAudioPcm(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    console.log(`[CLI] Extracting 16kHz PCM audio via ffmpeg from: ${filePath}`);
    const ffmpeg = spawn('ffmpeg', [
      '-i', filePath,
      '-f', 's16le',
      '-ar', '16000',
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`Failed to run ffmpeg: ${err.message}. Please ensure ffmpeg is installed and on PATH.`));
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 || chunks.length > 0) {
        const fullBuffer = Buffer.concat(chunks);
        console.log(`[CLI] Extracted ${fullBuffer.length} bytes of 16kHz PCM audio (~${(fullBuffer.length / 32000).toFixed(1)}s).`);
        resolve(fullBuffer);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

function loadBenchmark(benchmarkPath: string): BenchmarkItem[] {
  if (!fs.existsSync(benchmarkPath)) {
    console.warn(`[CLI] Benchmark file not found at: ${benchmarkPath}`);
    return [];
  }

  const raw = fs.readFileSync(benchmarkPath, 'utf-8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#'));
  const items: BenchmarkItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const secs = parseTimecode(line);
    if (secs !== null) {
      items.push({
        lineIndex: i + 1,
        raw: line,
        seconds: secs,
      });
    }
  }

  return items;
}

export async function runCli(): Promise<void> {
  const options = parseCliArgs();

  console.log('='.repeat(70));
  console.log('🚀 Skipper 命令行评测套件 (STT -> LLM 智能筛选 -> Benchmark 比对)');
  console.log('='.repeat(70));
  console.log(`- 目标音视频: ${options.file}`);
  console.log(`- 基准文件:   ${options.benchmark || '(未提供)'}`);
  console.log(`- STT 引擎:   ${options.sttProvider}`);
  console.log(`- LLM 模型:   ${options.model} (${options.baseUrl})`);
  console.log(`- 匹配容差:   ±${options.toleranceSec}s`);
  console.log('-'.repeat(70));

  if (!fs.existsSync(options.file)) {
    console.error(`❌ 输入文件不存在: ${options.file}`);
    process.exit(1);
  }

  // 1. Load benchmark file if specified
  const benchmarkItems: BenchmarkItem[] = options.benchmark ? loadBenchmark(options.benchmark) : [];
  console.log(`[CLI] Loaded ${benchmarkItems.length} ground-truth checkpoints from benchmark file.`);

  // 2. Extract 16kHz PCM audio
  let pcmBuffer: Buffer;
  try {
    pcmBuffer = await extractAudioPcm(options.file);
  } catch (err: any) {
    console.error(`❌ 音频提取失败:`, err.message);
    process.exit(1);
  }

  // 3. Initialize STT Provider
  const sttProvider: ISTTProvider = createSTTProvider({
    provider: options.sttProvider,
    languageCode: 'zh-CN',
    rollingWindowSec: 30,
    whisperModelSize: options.whisperModelSize || 'small',
    sherpaEmbeddingModelType: options.sherpaEmbeddingModelType || 'campplus',
    manualTeacherId: options.manualTeacherId || null,
    enableNativeWhisper: options.enableNativeWhisper,
  });

  // 4. Determine Active Goals
  let activeGoals: GoalItem[] = [];
  if (options.goals && options.goals.length > 0) {
    activeGoals = options.goals.map((text, idx) => ({
      id: `cli-goal-${idx + 1}`,
      text,
      enabled: true,
    }));
  } else {
    const targetGoalsFile = options.goalsFile || 'test-assets/benchmark_goals.json';
    if (fs.existsSync(targetGoalsFile)) {
      try {
        const raw = fs.readFileSync(targetGoalsFile, 'utf-8');
        activeGoals = JSON.parse(raw);
        console.log(`[CLI] Loaded ${activeGoals.length} goals from: ${targetGoalsFile}`);
      } catch (err: any) {
        console.warn(`[CLI] Failed to load goals file ${targetGoalsFile}: ${err.message}`);
      }
    }
  }

  console.log(`[CLI] Active Screening Goals (${options.goalLogic || DEFAULT_GOAL_LOGIC}):`);
  activeGoals.forEach((g, i) => {
    console.log(`   ${i + 1}. [${g.id}] ${g.text}`);
  });

  // 5. Initialize LLM Client and Screening Engine
  const llmClient = new LLMClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    defaultModel: options.model,
    timeoutMs: 30000,
  });

  const screeningEngine = new ScreeningEngine({
    llmClient,
    goals: activeGoals,
    goalLogic: options.goalLogic || DEFAULT_GOAL_LOGIC,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    compactPrompt: DEFAULT_COMPACT_PROMPT,
    thresholds: {
      pauseThresholdSec: PAUSE_THRESHOLD_SECONDS,
      minIntervalSec: MIN_INTERVAL_SECONDS,
      maxIntervalSec: MAX_INTERVAL_SECONDS,
    },
    maxContextTokens: 8192,
    compactThresholdRatio: 0.60,
  });

  // Attach STT to Screening Engine
  screeningEngine.attachSTT(sttProvider);

  // Storage for full outputs
  const allSegments: STTSegment[] = [];
  const allEvaluations: EvaluationLog[] = [];
  const triggeredAlerts: Array<{ timestampSeconds: number; verdict: ScreeningVerdict }> = [];

  sttProvider.on('segment', (seg) => {
    allSegments.push(seg);
    console.log(`[STT] [${formatSeconds(seg.startTime)} - ${formatSeconds(seg.endTime)}] [${seg.speaker || 'Teacher'}]: ${seg.text}`);

    if (typeof (sttProvider as any).getTeacherResolver === 'function') {
      const resolver = (sttProvider as any).getTeacherResolver();
      resolver.maybeInferTeacherViaLLM(llmClient, seg.endTime).catch(() => {});
    }
  });

  if (typeof (sttProvider as any).getTeacherResolver === 'function') {
    const resolver = (sttProvider as any).getTeacherResolver();
    resolver.on('teacherChanged', (teacherId: string, isManual: boolean, reason?: string) => {
      console.log(`[TeacherResolver] ★ Teacher role updated: [${teacherId}] (${isManual ? 'Manual' : 'LLM Inferred: ' + reason})`);
    });
  }

  screeningEngine.on('evaluation', (evalLog) => {
    allEvaluations.push(evalLog);
    const statusMark = evalLog.verdict.triggered ? '🔔 TRIGGERED' : '💤 NO_TRIGGER';
    console.log(
      `[LLM Call #${allEvaluations.length}] [${evalLog.triggerType.toUpperCase()}] ${statusMark} (耗时: ${evalLog.durationMs}ms)`
    );
    console.log(`      Topic: ${evalLog.verdict.currentTopic || 'N/A'}`);
    console.log(`      Reason: ${evalLog.verdict.reason}`);
    if (evalLog.verdict.summary) {
      console.log(`      Summary: ${evalLog.verdict.summary}`);
    }
  });

  screeningEngine.on('alert', (verdict) => {
    const currentStreamTime = allSegments.length > 0 ? allSegments[allSegments.length - 1].endTime : 0;
    triggeredAlerts.push({
      timestampSeconds: currentStreamTime,
      verdict,
    });
    console.log(`\n🚨 >>> 触发课堂提醒 (Stream Time: ${formatSeconds(currentStreamTime)}) <<<`);
    console.log(`   【${verdict.reason}】`);
    console.log(`   ${verdict.summary}\n`);
  });

  screeningEngine.on('compact', (compactState) => {
    console.log(`[COMPACT] 上下文达到 60% 阈值，完成压缩！压缩后摘要字数: ${compactState.summary.length}`);
  });

  // 5. Start STT & Feed Audio
  console.log('\n[CLI] Starting STT & Screening Engine pipeline...');
  await sttProvider.start();

  const chunkSize = 16000 * 2 * 1; // 1 second of 16kHz 16-bit mono PCM = 32000 bytes
  let offset = 0;

  const startTimeWall = Date.now();
  while (offset < pcmBuffer.length) {
    const end = Math.min(offset + chunkSize, pcmBuffer.length);
    const chunk = pcmBuffer.subarray(offset, end);
    sttProvider.feedAudio(chunk);
    offset = end;

    // If an evaluation or compaction was triggered by speech pause, wait for LLM to finish!
    while (screeningEngine.getStats().isEvaluating || screeningEngine.getStats().isCompacting) {
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!options.fastMode) {
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // Wait for any trailing STT / LLM triggers to finish
  console.log('[CLI] Audio stream feed complete. Awaiting final analysis...');
  if (typeof (sttProvider as any).waitForPendingUtterances === 'function') {
    await (sttProvider as any).waitForPendingUtterances();
  }
  while (screeningEngine.getStats().isEvaluating || screeningEngine.getStats().isCompacting) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 2000));

  // If there are uncompacted segments left, trigger a final evaluation
  if (screeningEngine.getStats().uncompactedCount > 0) {
    await screeningEngine.triggerManualEvaluation('StreamEnd');
  }

  await sttProvider.stop();
  const totalElapsedMs = Date.now() - startTimeWall;

  console.log('\n' + '='.repeat(70));
  console.log('📊 评测完成 - 结果统计分析报告');
  console.log('='.repeat(70));
  console.log(`- 处理总用时: ${(totalElapsedMs / 1000).toFixed(2)} 秒`);
  console.log(`- STT 转写总段数: ${allSegments.length} 段`);
  console.log(`- LLM 评估总调用次数: ${allEvaluations.length} 次`);
  console.log(`- 提醒触发次数: ${triggeredAlerts.length} 次`);

  // 6. Benchmark Comparison
  console.log('\n' + '-'.repeat(70));
  console.log('🎯 Benchmark 权威比对矩阵');
  console.log('-'.repeat(70));

  let matchedCount = 0;
  let totalLatencySec = 0;
  const missedBenchmarks: BenchmarkItem[] = [];

  for (const b of benchmarkItems) {
    // Find closest triggered alert within tolerance window [b.seconds - toleranceSec, b.seconds + toleranceSec]
    let bestMatch: (typeof triggeredAlerts)[0] | null = null;
    let minDiff = Infinity;

    for (const alert of triggeredAlerts) {
      const diff = alert.timestampSeconds - b.seconds;
      if (diff >= -options.toleranceSec && diff <= options.toleranceSec) {
        if (Math.abs(diff) < minDiff) {
          minDiff = Math.abs(diff);
          bestMatch = alert;
        }
      }
    }

    if (bestMatch) {
      const latency = bestMatch.timestampSeconds - b.seconds;
      b.matchedTrigger = {
        timestamp: Date.now(),
        seconds: bestMatch.timestampSeconds,
        verdict: bestMatch.verdict,
        latencySec: latency,
      };
      matchedCount++;
      totalLatencySec += Math.max(0, latency);

      console.log(
        `✅ [标准点 ${formatSeconds(b.seconds)}] -> 命中提醒于 ${formatSeconds(bestMatch.timestampSeconds)} (延迟: ${latency >= 0 ? '+' : ''}${latency.toFixed(1)}s)`
      );
      console.log(`   说明: ${bestMatch.verdict.reason}`);
    } else {
      missedBenchmarks.push(b);
      console.log(`❌ [标准点 ${formatSeconds(b.seconds)}] -> 漏报 (未在该容差窗口内检测到有效提醒)`);
    }
  }

  // Calculate False Positives (alerts not matching any benchmark point)
  const falsePositives = triggeredAlerts.filter((alert) => {
    return !benchmarkItems.some((b) => {
      const diff = alert.timestampSeconds - b.seconds;
      return diff >= -options.toleranceSec && diff <= options.toleranceSec;
    });
  });

  const avgLatency = matchedCount > 0 ? (totalLatencySec / matchedCount).toFixed(2) : '0.00';
  const recallRate = benchmarkItems.length > 0 ? ((matchedCount / benchmarkItems.length) * 100).toFixed(1) : '100.0';

  console.log('-'.repeat(70));
  console.log(`📈 核心评测指标:`);
  console.log(`  • 标准点总数 (Ground Truth):  ${benchmarkItems.length}`);
  console.log(`  • 命中数量 (Hits):            ${matchedCount}`);
  console.log(`  • 漏报数量 (Missed):          ${missedBenchmarks.length} (${missedBenchmarks.map((m) => formatSeconds(m.seconds)).join(', ') || '无'})`);
  console.log(`  • 误报数量 (False Positives):  ${falsePositives.length}`);
  console.log(`  • 召回率 (Recall):            ${recallRate}%`);
  console.log(`  • 平均延迟 (Average Latency): ${avgLatency} 秒`);
  console.log('='.repeat(70));

  // 7. Save results to output directory
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }

  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonReportPath = path.join(options.outputDir, `report-${timestampStr}.json`);
  const mdReportPath = path.join(options.outputDir, `report-${timestampStr}.md`);

  const reportData = {
    metadata: {
      date: new Date().toISOString(),
      inputFile: options.file,
      benchmarkFile: options.benchmark,
      sttProvider: options.sttProvider,
      llmModel: options.model,
      toleranceSec: options.toleranceSec,
      totalElapsedSec: totalElapsedMs / 1000,
    },
    metrics: {
      groundTruthTotal: benchmarkItems.length,
      hits: matchedCount,
      missedCount: missedBenchmarks.length,
      missedTimestamps: missedBenchmarks.map((m) => formatSeconds(m.seconds)),
      falsePositivesCount: falsePositives.length,
      averageLatencySeconds: parseFloat(avgLatency),
      recallRatePercent: parseFloat(recallRate),
    },
    benchmarkComparison: benchmarkItems.map((b) => ({
      groundTruth: formatSeconds(b.seconds),
      status: b.matchedTrigger ? 'HIT' : 'MISSED',
      triggeredAt: b.matchedTrigger ? formatSeconds(b.matchedTrigger.seconds) : null,
      latencySeconds: b.matchedTrigger ? b.matchedTrigger.latencySec : null,
      reason: b.matchedTrigger ? b.matchedTrigger.verdict.reason : null,
    })),
    llmCalls: allEvaluations.map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      triggerType: e.triggerType,
      durationMs: e.durationMs,
      triggered: e.verdict.triggered,
      reason: e.verdict.reason,
      summary: e.verdict.summary,
      topic: e.verdict.currentTopic,
    })),
    sttSegmentsCount: allSegments.length,
    sttSegments: allSegments,
  };

  fs.writeFileSync(jsonReportPath, JSON.stringify(reportData, null, 2), 'utf-8');

  const mdReport = `# Skipper 自动化评测报告
**生成时间**：${new Date().toLocaleString()}  
**测试文件**：\`${options.file}\`  
**基准文件**：\`${options.benchmark || 'None'}\`  
**模型**：\`${options.model}\` (\`${options.baseUrl}\`)  

## 核心指标
| 指标项 | 数值 |
| :--- | :--- |
| **标准点总数 (Ground Truth)** | ${benchmarkItems.length} |
| **成功命中 (Hits)** | ${matchedCount} |
| **漏报数量 (Missed)** | ${missedBenchmarks.length} (${missedBenchmarks.map((m) => formatSeconds(m.seconds)).join(', ') || '无'}) |
| **误报数量 (False Positives)** | ${falsePositives.length} |
| **召回率 (Recall)** | **${recallRate}%** |
| **平均延迟 (Average Latency)** | **${avgLatency} 秒** |

## Benchmark 比对明细
| 标准时间戳 | 判定状态 | 触发时间戳 | 延迟 (s) | 触发理由 |
| :--- | :--- | :--- | :--- | :--- |
${benchmarkItems
  .map(
    (b) =>
      `| \`${formatSeconds(b.seconds)}\` | ${b.matchedTrigger ? '✅ **HIT**' : '❌ **MISSED**'} | ${b.matchedTrigger ? `\`${formatSeconds(b.matchedTrigger.seconds)}\`` : '--'} | ${b.matchedTrigger ? `${b.matchedTrigger.latencySec.toFixed(1)}s` : '--'} | ${b.matchedTrigger ? b.matchedTrigger.verdict.reason : '未命中'} |`
  )
  .join('\n')}

## LLM 筛选全量记录 (共 ${allEvaluations.length} 次调用)
${allEvaluations
  .map(
    (e, idx) => `
### 调用 #${idx + 1} (${e.triggerType.toUpperCase()} - 耗时 ${e.durationMs}ms)
- **触发状态**: ${e.verdict.triggered ? '🔔 **已提醒**' : '💤 未提醒'}
- **当前板块**: ${e.verdict.currentTopic || '未指定'}
- **判定理由**: ${e.verdict.reason}
- **教学摘要**: ${e.verdict.summary || '无'}
`
  )
  .join('\n')}
`;

  fs.writeFileSync(mdReportPath, mdReport, 'utf-8');
  console.log(`\n📁 评测报告已持久化写入:`);
  console.log(`  • JSON: ${jsonReportPath}`);
  console.log(`  • Markdown: ${mdReportPath}`);
}

// Direct execution entrypoint
if (require.main === module) {
  runCli().catch((err) => {
    console.error('[CLI Error]', err);
    process.exit(1);
  });
}
