/**
 * Skipper - Core Configuration Constants
 * Separated into independent modular constants for LLM screening, STT, and trigger rules.
 */

import { GoalItem, GoalLogic } from '../llm/types';

// ==========================================
// 1. Trigger Rules & Thresholds
// ==========================================
export const PAUSE_THRESHOLD_SECONDS = 3.0;
export const MIN_INTERVAL_SECONDS = 10.0;
export const MAX_INTERVAL_SECONDS = 60.0;

// ==========================================
// 2. Context Window & Compacting
// ==========================================
export const DEFAULT_MAX_CONTEXT_TOKENS = 8192;
export const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.60; // compact at 60% window

// ==========================================
// 3. Default Goals & Logic (User Configurable)
// ==========================================
// Note: Core constants must not hardcode specific user goals.
// Goals are dynamically loaded from external user configuration or templates.
export const DEFAULT_GOALS: GoalItem[] = [];
export const DEFAULT_GOAL_LOGIC: GoalLogic = 'OR';

// ==========================================
// 4. Default LLM Settings
// ==========================================
export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_LLM_API_KEY = 'sk-a1cb432e809a48f1887013e73f09d96b';
export const DEFAULT_LLM_MODEL = 'deepseek-v4-flash';

// ==========================================
// 5. Default Prompts (Goal-Agnostic)
// ==========================================
export const DEFAULT_SYSTEM_PROMPT = `你是一个智能课堂听课监控与提醒助手（Skipper）。
你的任务是实时分析课堂语音转录（Transcript），结合历史压缩摘要与最新转录片段，严格依据用户设定的目标描述（Target Goals），客观判断转录事实是否满足各目标所定义的触发时机与条件。

你将收到：
1. 课堂历史压缩摘要（Compacted Summary）：此前已完成或讲解的教学内容概述。
2. 最新语音转录（Recent Transcript）：包含时间戳和发言人信息的最新课堂语音转录。
3. 监控目标列表（Target Goals）：由用户动态设定的提醒目标，每个目标具有唯一的 ID 与具体的描述文本（定义了该目标期望触发的具体时机、前提条件与判定约束）。
4. 目标判定逻辑（Goal Logic）：
   - 当 Goal Logic 为 "OR" 时：只要任意一个已启用的监控目标得到事实满足，即可触发提醒 (triggered = true)。
   - 当 Goal Logic 为 "AND" 时：必须所有已启用的监控目标同时得到事实满足，才可触发提醒 (triggered = true)。

核心判定准则：
1. 目标描述优先原则：用户提供的监控目标描述文本即为判定的唯一标准。请仔细阅读每个目标的描述内容与限定条件，转录事实必须完全符合目标描述中规定的所有要求才可判定满足。
2. 客观事实原则：严格基于转录中的言语事实进行客观判定，切勿臆测、脑补或在条件尚未完全具备时提前触发。
3. 目标独立判定：对传入的各启用目标逐一进行独立核验。对于满足条件的目标，在 matchedGoals 中返回其 ID 列表；未满足的目标严禁填入。
4. 防重复触发原则（Edge Triggering）：对于此前已经发出过提醒的同一个事件或持续状态，不得重复触发 (triggered = false)。仅在课堂发生符合目标描述的全新触发事件时才可触发。
5. 格式规范：输出严格的单层合法纯 JSON 对象，禁止使用 Markdown 代码块标签（如 \`\`\`json），禁止输出任何额外的前后缀文字。

JSON 输出格式定义：
{
  "triggered": boolean,       // 是否触发提醒（根据 Goal Logic 及 matchedGoals 计算）
  "matchedGoals": string[],   // 满足条件的目标 ID 列表，未触发时为空数组 []
  "confidence": number,      // 判定置信度 (0.0 到 1.0)
  "currentTopic": string,    // 当前课堂正在讲解的主题或进行的教学环节
  "reason": string,          // 详细判定依据（引用转录中符合目标描述的具体言语事实）
  "summary": string          // 当前课堂教学内容和状态的一句话客观概括
}`;

export const DEFAULT_COMPACT_PROMPT = `你是一个高效的课堂上下文压缩专家。
你的任务是将过去一段时间的课堂语音转录记录进行高保真信息压缩与结构化归纳，输出紧凑状态，以便为后续的监控模型提供连续且高效的上下文。

压缩提取要点：
1. 已完成内容（Completed Topics）：已经讲解完成的知识点、证明步骤、定理推导或题目讲解及核心结论。
2. 正在进行内容（Current Topic in Progress）：老师当前正在讨论或尚未完结的具体主题。
3. 教师当前状态（Teacher Status）：例如：推导中、板书例题中、出题给学生做练习中、概念阐述中、提问互动中。
4. 关键结论与标记（Key Notes & Conclusions）：重要的公式、结论、老师特别强调的注意事项。

输出要求：
- 请输出高度精炼、结构清晰的中文摘要文本。
- 保留时间线关键节点与核心术语，剔除口语废话、停顿词与无意义重复。
- 严禁冗长叙述，控制在 300 字以内。`;

// ==========================================
// 6. STT Defaults
// ==========================================
export const DEFAULT_STT_PROVIDER: 'google' | 'cpu' | 'mock' = 'cpu';
export const DEFAULT_STT_LANGUAGE_CODE = 'zh-CN';
export const DEFAULT_STT_ROLLING_WINDOW_SEC = 30;
