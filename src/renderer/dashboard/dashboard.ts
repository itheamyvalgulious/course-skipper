/**
 * Skipper - Classroom Live Stream AI Assistant
 * Dashboard Controller & Frontend Logic
 */

interface GoalItem {
  id: string;
  text: string;
  enabled: boolean;
}

// Global State
let currentGoals: GoalItem[] = [];
let currentGoalLogic: 'OR' | 'AND' = 'OR';
let isBrowserVisible = true;

// WebAudio Capturer State
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let isCapturingAudio = false;

// DOM Elements: Navigation & Sidebar
const tabs = document.querySelectorAll<HTMLButtonElement>('.nav-tab');
const statusPill = document.getElementById('system-status-pill')!;
const statusText = document.getElementById('system-status-text')!;

// DOM Elements: Main Pane
const inputBrowserUrl = document.getElementById('browser-url') as HTMLInputElement;
const btnOpenBrowser = document.getElementById('btn-open-browser')!;
const btnToggleBrowserView = document.getElementById('btn-toggle-browser-view')!;
const browserStatusTag = document.getElementById('browser-status-tag')!;
const pipelineStatusText = document.getElementById('pipeline-status-text')!;

const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnResume = document.getElementById('btn-resume') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnTestAlert = document.getElementById('btn-test-alert')!;

const audioMeterFill = document.getElementById('audio-meter-fill')!;
const audioMeterText = document.getElementById('audio-meter-text')!;
const checkboxMuteLocal = document.getElementById('checkbox-mute-local') as HTMLInputElement;

// Speaker Tracks Elements
const activeTeacherBadge = document.getElementById('active-teacher-badge')!;
const selectManualTeacher = document.getElementById('select-manual-teacher') as HTMLSelectElement;
const speakerTracksContainer = document.getElementById('speaker-tracks-container')!;

const transcriptFeed = document.getElementById('transcript-feed')!;
const btnClearTranscript = document.getElementById('btn-clear-transcript')!;

// Alert Card Elements
const alertBadge = document.getElementById('alert-badge')!;
const alertReason = document.getElementById('alert-reason')!;
const alertSummary = document.getElementById('alert-summary')!;
const alertMatchedGoals = document.getElementById('alert-matched-goals')!;
const alertConfidence = document.getElementById('alert-confidence')!;
const alertTime = document.getElementById('alert-time')!;

// DOM Elements: Settings Pane
const radioLogicOr = document.getElementById('logic-or') as HTMLInputElement;
const radioLogicAnd = document.getElementById('logic-and') as HTMLInputElement;
const btnPresetGoal1 = document.getElementById('btn-preset-goal-1')!;
const btnPresetGoal2 = document.getElementById('btn-preset-goal-2')!;
const goalsContainer = document.getElementById('goals-list-container')!;
const inputCustomGoal = document.getElementById('input-custom-goal') as HTMLInputElement;
const btnAddGoal = document.getElementById('btn-add-goal')!;

const inputLlmBaseUrl = document.getElementById('llm-base-url') as HTMLInputElement;
const inputLlmApiKey = document.getElementById('llm-api-key') as HTMLInputElement;
const inputLlmModel = document.getElementById('llm-model') as HTMLInputElement;
const inputLlmMaxTokens = document.getElementById('llm-max-tokens') as HTMLInputElement;
const inputLlmCompactRatio = document.getElementById('llm-compact-ratio') as HTMLInputElement;

const radioSttGoogle = document.getElementById('stt-google') as HTMLInputElement;
const radioSttCpu = document.getElementById('stt-cpu') as HTMLInputElement;
const radioSttFunasr = document.getElementById('stt-funasr') as HTMLInputElement;
const sttGoogleContainer = document.getElementById('stt-google-container')!;
const inputSttGoogleKey = document.getElementById('stt-google-key') as HTMLInputElement;
const inputSttLanguageCode = document.getElementById('stt-language-code') as HTMLInputElement;
const inputSttRollingWindow = document.getElementById('stt-rolling-window') as HTMLInputElement;
const selectWhisperModel = document.getElementById('stt-whisper-model') as HTMLSelectElement;
const selectSherpaModel = document.getElementById('stt-sherpa-model') as HTMLSelectElement;
const btnSaveAllSettings = document.getElementById('btn-save-all-settings')!;

// DOM Elements: Debug Pane
const textareaSystemPrompt = document.getElementById('textarea-system-prompt') as HTMLTextAreaElement;
const btnSaveSystemPrompt = document.getElementById('btn-save-system-prompt')!;
const textareaCompactPrompt = document.getElementById('textarea-compact-prompt') as HTMLTextAreaElement;
const btnSaveCompactPrompt = document.getElementById('btn-save-compact-prompt')!;

const inputConstantPauseThreshold = document.getElementById('constant-pause-threshold') as HTMLInputElement;
const inputConstantMinInterval = document.getElementById('constant-min-interval') as HTMLInputElement;
const inputConstantMaxInterval = document.getElementById('constant-max-interval') as HTMLInputElement;
const inputConstantCompactRatio = document.getElementById('constant-compact-ratio') as HTMLInputElement;
const btnSaveConstants = document.getElementById('btn-save-constants')!;

const logContainer = document.getElementById('log-container')!;
const btnClearLog = document.getElementById('btn-clear-log')!;
const toastContainer = document.getElementById('toast-container')!;

// ========================================================
// 1. Tab Switching & UI Navigation
// ========================================================
function switchTab(tabId: string): void {
  tabs.forEach((tab) => {
    if (tab.id === tabId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  const targetPaneId = document.getElementById(tabId)?.getAttribute('data-target');
  document.querySelectorAll<HTMLElement>('.tab-pane').forEach((pane) => {
    if (pane.id === targetPaneId) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    if (!tab.classList.contains('nav-tab-disabled')) {
      switchTab(tab.id);
    }
  });
});

// Toast Notifications Helper
function showToast(message: string, type: 'success' | 'warning' | 'error' | 'info' = 'success'): void {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 2800);
}

// Event Logger
function appendLog(text: string, type: 'info' | 'alert' | 'error' | 'success' = 'info'): void {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'alert' ? 'log-entry-alert' : type === 'error' ? 'log-entry-error' : type === 'success' ? 'log-entry-success' : ''}`;
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">[${time}]</span> ${text}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

btnClearLog.addEventListener('click', () => {
  logContainer.innerHTML = '';
});

// ========================================================
// 2. Monitoring State & Control Pipeline
// ========================================================
function updateStateBadge(state: string): void {
  statusPill.className = `status-pill status-${state}`;
  const stateLabels: Record<string, string> = {
    idle: '未开始 (IDLE)',
    initializing: '初始化中 (INITIALIZING)',
    ready: '待命就绪 (READY)',
    monitoring: '监控中 (MONITORING)',
    paused: '已暂停 (PAUSED)',
    error: '运行异常 (ERROR)',
  };
  statusText.innerText = stateLabels[state] || state.toUpperCase();
  pipelineStatusText.innerText = stateLabels[state] || state;

  if (state === 'monitoring') {
    pipelineStatusText.className = 'badge badge-success';
    btnStart.style.display = 'none';
    btnResume.style.display = 'none';
    btnPause.style.display = 'inline-flex';
    btnPause.disabled = false;
    btnStop.disabled = false;
  } else if (state === 'paused') {
    pipelineStatusText.className = 'badge badge-warning';
    btnStart.style.display = 'none';
    btnPause.style.display = 'none';
    btnResume.style.display = 'inline-flex';
    btnResume.disabled = false;
    btnStop.disabled = false;
  } else if (state === 'ready') {
    pipelineStatusText.className = 'badge badge-info';
    btnStart.style.display = 'inline-flex';
    btnStart.disabled = false;
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnStop.disabled = true;
  } else {
    pipelineStatusText.className = 'badge badge-muted';
    btnStart.style.display = 'inline-flex';
    btnStart.disabled = false;
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnStop.disabled = true;
  }
}

// Audio Meter update
function updateAudioMeter(level: number): void {
  const percent = Math.min(100, Math.max(0, Math.round(level * 300)));
  audioMeterFill.style.width = `${percent}%`;
  audioMeterText.innerText = `${percent}%`;
}

// Audio Capture Setup
async function startAudioCapture(): Promise<boolean> {
  if (isCapturingAudio) return true;

  try {
    appendLog('正在建立 WebFrameMain 音频采集管道 (getDisplayMedia)...');
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      appendLog('警告: 未捕获到目标页面音频轨，请确保目标窗口正在播放音频', 'error');
      return false;
    }

    const audioTrack = audioTracks[0];
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      sampleRate: 16000,
    });

    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        sum += input[i] * input[i];
      }
      const rms = Math.sqrt(sum / input.length);

      // Convert to 16-bit PCM little-endian
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Send to main process via IPC
      (window as any).skipperAPI.sendAudioChunk?.(pcm16.buffer, rms);
      updateAudioMeter(rms);
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    isCapturingAudio = true;
    appendLog('✓ 16kHz PCM 音频流已打通', 'success');
    return true;
  } catch (err: any) {
    appendLog(`音频捕获启动异常: ${err?.message || err}`, 'error');
    return false;
  }
}

function stopAudioCapture(): void {
  if (!isCapturingAudio) return;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  isCapturingAudio = false;
  updateAudioMeter(0);
  appendLog('音频采集流已断开');
}

// Local mute checkbox
checkboxMuteLocal.addEventListener('change', async () => {
  const muted = checkboxMuteLocal.checked;
  await (window as any).skipperAPI.setMuteLocal(muted);
  showToast(muted ? '已开启本地静音 (仅传给AI监听)' : '已开启本地扬声器播放');
  appendLog(muted ? '本地扬声器已静音' : '本地扬声器已开启播放');
});

// Transcript Feed append helper
function appendTranscriptSegment(seg: any): void {
  const empty = transcriptFeed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'transcript-line';
  const time = seg.timestamp ? new Date(seg.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
  const speaker = seg.speaker || '老师';
  line.innerHTML = `<span class="transcript-time">[${time}]</span><span class="transcript-speaker">[${speaker}]:</span><span class="transcript-text">${seg.text}</span>`;
  transcriptFeed.appendChild(line);
  transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
}

btnClearTranscript.addEventListener('click', () => {
  transcriptFeed.innerHTML = '<div class="feed-empty">等待直播语音输入，识别的转录文本将在此处实时流水滚动显示...</div>';
});

// HTML escaping helper
function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Speaker Tracks rendering
function renderSpeakerTracks(tracks: any[]): void {
  if (!speakerTracksContainer) return;

  if (!Array.isArray(tracks) || tracks.length === 0) {
    speakerTracksContainer.innerHTML = '<div class="feed-empty">等待声纹分离与说话人检测（音频输入后自动生成各音轨与发言记录）</div>';
    return;
  }

  // Find active teacher
  const teacherTrack = tracks.find((t) => t.isTeacher);
  if (teacherTrack) {
    const isManual = selectManualTeacher.value !== '';
    activeTeacherBadge.innerText = `主讲老师: ${teacherTrack.id} (${isManual ? '用户指定' : 'AI识别'})`;
    activeTeacherBadge.className = 'badge badge-success';
  } else {
    activeTeacherBadge.innerText = '主讲老师: 自动识别中';
    activeTeacherBadge.className = 'badge badge-info';
  }

  // Update dropdown options while preserving selection
  const currentVal = selectManualTeacher.value;
  const prevOptions = Array.from(selectManualTeacher.options).map((o) => o.value);
  const trackIds = tracks.map((t) => t.id);

  let needsRebuild = false;
  if (prevOptions.length !== trackIds.length + 1) {
    needsRebuild = true;
  } else {
    for (let i = 0; i < trackIds.length; i++) {
      if (prevOptions[i + 1] !== trackIds[i]) {
        needsRebuild = true;
        break;
      }
    }
  }

  if (needsRebuild) {
    selectManualTeacher.innerHTML = '<option value="">🤖 自动判定 (每3分钟大模型研判)</option>';
    for (const track of tracks) {
      const opt = document.createElement('option');
      opt.value = track.id;
      opt.textContent = `${track.id} (指定为主讲老师)`;
      selectManualTeacher.appendChild(opt);
    }
    if (trackIds.includes(currentVal)) {
      selectManualTeacher.value = currentVal;
    } else {
      selectManualTeacher.value = '';
    }
  }

  // Render cards
  speakerTracksContainer.innerHTML = '';
  for (const track of tracks) {
    const card = document.createElement('div');
    card.className = `speaker-track-card ${track.isTeacher ? 'is-teacher' : ''}`;

    const top = document.createElement('div');
    top.className = 'track-card-top';

    const title = document.createElement('span');
    title.className = 'track-title';
    title.innerHTML = `<span>🎙️ ${escapeHtml(track.id)}</span> <span class="${track.isTeacher ? 'track-tag-teacher' : 'track-tag-student'}">${track.isTeacher ? '★ 主讲老师' : '学生/旁听'}</span>`;

    const stats = document.createElement('span');
    stats.className = 'track-stats';
    stats.textContent = `${track.totalDurationSec.toFixed(1)}s (${track.utteranceCount}次)`;

    top.appendChild(title);
    top.appendChild(stats);

    const utterancesBox = document.createElement('div');
    utterancesBox.className = 'track-recent-utterances';
    if (Array.isArray(track.recentUtterances) && track.recentUtterances.length > 0) {
      utterancesBox.innerHTML = track.recentUtterances
        .map((u: string) => `<span>• ${escapeHtml(u)}</span>`)
        .join('');
    } else {
      utterancesBox.innerHTML = '<span style="color: #64748b;">(暂无发言记录)</span>';
    }

    card.appendChild(top);
    card.appendChild(utterancesBox);
    speakerTracksContainer.appendChild(card);
  }
}

selectManualTeacher.addEventListener('change', async () => {
  const selectedId = selectManualTeacher.value.trim() || null;
  try {
    await (window as any).skipperAPI.setManualTeacher(selectedId);
    if (selectedId) {
      showToast(`已手动指定主讲老师为: ${selectedId}`, 'success');
      appendLog(`[主讲老师设定] 用户手动绑定: ${selectedId}`);
    } else {
      showToast('已切换为自动研判主讲老师模式（每3分钟评估）', 'info');
      appendLog('[主讲老师设定] 切换为大模型自动识别模式');
    }
    const tracks = await (window as any).skipperAPI.getSpeakerTracks();
    if (Array.isArray(tracks)) renderSpeakerTracks(tracks);
  } catch (err: any) {
    showToast(`设置主讲老师失败: ${err?.message || err}`, 'error');
  }
});

// Browser Open & View Control
btnOpenBrowser.addEventListener('click', async () => {
  const url = inputBrowserUrl.value.trim();
  appendLog(`正在打开直播窗口: ${url || '默认空白页'}`);
  await (window as any).skipperAPI.openBrowser(url || undefined);
  browserStatusTag.innerText = '直播窗口已开启';
  browserStatusTag.className = 'badge badge-info';
  showToast('直播浏览器已打开');
});

btnToggleBrowserView.addEventListener('click', async () => {
  if (isBrowserVisible) {
    await (window as any).skipperAPI.hideBrowser();
    isBrowserVisible = false;
    btnToggleBrowserView.innerHTML = '<span>👁 显示浏览器</span>';
    showToast('直播窗口已最小化到后台监控');
    appendLog('直播浏览器已置入后台继续无限制运行');
  } else {
    await (window as any).skipperAPI.showBrowser();
    isBrowserVisible = true;
    btnToggleBrowserView.innerHTML = '<span>👁 显/隐浏览器</span>';
    showToast('直播窗口已恢复显示');
    appendLog('直播浏览器已唤起至前台');
  }
});

// Start / Pause / Resume / Stop Monitoring
btnStart.addEventListener('click', async () => {
  appendLog('🚀 正在启动监控流程...');
  try {
    if (!isCapturingAudio) {
      await startAudioCapture();
    }
    await (window as any).skipperAPI.startMonitoring();
    appendLog('✓ 监控调度已就绪，正在实时监听语音与画面', 'success');
    showToast('课堂监控已启动！', 'success');
  } catch (err: any) {
    appendLog(`启动监控失败: ${err?.message || err}`, 'error');
    showToast(`启动失败: ${err?.message || err}`, 'error');
  }
});

btnPause.addEventListener('click', async () => {
  appendLog('⏸ 正在暂停监控...');
  await (window as any).skipperAPI.pauseMonitoring();
  showToast('监控已暂停');
});

btnResume.addEventListener('click', async () => {
  appendLog('▶ 正在恢复监控...');
  await (window as any).skipperAPI.resumeMonitoring();
  showToast('监控已恢复', 'success');
});

btnStop.addEventListener('click', async () => {
  appendLog('⏹ 正在停止监控...');
  await (window as any).skipperAPI.stopMonitoring();
  stopAudioCapture();
  showToast('监控已停止');
});

btnTestAlert.addEventListener('click', async () => {
  appendLog('[测试演练] 触发桌面弹窗与提醒卡片测试...');
  await (window as any).skipperAPI.testNotification('测试提醒', 'Skipper 听课助手动作层弹窗与提醒机制工作正常！');
});

// ========================================================
// 3. Goals Management (Setting Tab)
// ========================================================
function renderGoals(): void {
  goalsContainer.innerHTML = '';
  if (currentGoals.length === 0) {
    goalsContainer.innerHTML = '<div style="color: var(--text-subtle); font-size: 12px; padding: 6px;">暂未添加监控目标，请在下方输入或使用快捷预设添加</div>';
    return;
  }

  currentGoals.forEach((goal) => {
    const item = document.createElement('div');
    item.className = 'goal-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = goal.enabled;
    checkbox.className = 'goal-checkbox';
    checkbox.title = '勾选以启用或停用此目标';
    checkbox.addEventListener('change', () => {
      goal.enabled = checkbox.checked;
    });

    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = goal.text;
    textInput.className = 'goal-text-input';
    textInput.addEventListener('change', () => {
      goal.text = textInput.value.trim();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'goal-delete-btn';
    delBtn.innerHTML = '🗑';
    delBtn.title = '删除此目标';
    delBtn.addEventListener('click', () => {
      currentGoals = currentGoals.filter((g) => g.id !== goal.id);
      renderGoals();
    });

    item.appendChild(checkbox);
    item.appendChild(textInput);
    item.appendChild(delBtn);
    goalsContainer.appendChild(item);
  });
}

function addGoalItem(text: string, enabled: boolean = true): void {
  if (!text) return;
  const newGoal: GoalItem = {
    id: `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    enabled,
  };
  currentGoals.push(newGoal);
  renderGoals();
  showToast(`已添加目标: "${text.slice(0, 20)}..."`, 'success');
}

btnAddGoal.addEventListener('click', () => {
  const text = inputCustomGoal.value.trim();
  if (text) {
    addGoalItem(text, true);
    inputCustomGoal.value = '';
  }
});

inputCustomGoal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = inputCustomGoal.value.trim();
    if (text) {
      addGoalItem(text, true);
      inputCustomGoal.value = '';
    }
  }
});

btnPresetGoal1.addEventListener('click', () => {
  const text = '一个知识点,证明或题目已经讲解完成,且已经开始讲解下一个内容板块（注意：仅上一内容推导完结、收尾回顾或互动确认不算达成，必须老师已经实质开启、引出或切入下一个新内容板块）';
  const exists = currentGoals.some((g) => g.text === text);
  if (!exists) {
    addGoalItem(text, true);
  } else {
    showToast('该预设目标已存在', 'warning');
  }
});

btnPresetGoal2.addEventListener('click', () => {
  const text = '老师写完一道题目 同学们该做了';
  const exists = currentGoals.some((g) => g.text === text);
  if (!exists) {
    addGoalItem(text, true);
  } else {
    showToast('该预设目标已存在', 'warning');
  }
});

// STT Provider Toggle
radioSttGoogle.addEventListener('change', () => {
  sttGoogleContainer.style.display = radioSttGoogle.checked ? 'flex' : 'none';
});

radioSttCpu.addEventListener('change', () => {
  sttGoogleContainer.style.display = radioSttGoogle.checked ? 'flex' : 'none';
});

if (radioSttFunasr) {
  radioSttFunasr.addEventListener('change', () => {
    sttGoogleContainer.style.display = radioSttGoogle.checked ? 'flex' : 'none';
  });
}

// Save All Settings Button
btnSaveAllSettings.addEventListener('click', async () => {
  const logic = radioLogicAnd.checked ? 'AND' : 'OR';
  currentGoalLogic = logic;

  let chosenSttProvider: 'google' | 'cpu' | 'funasr' = 'cpu';
  if (radioSttGoogle.checked) {
    chosenSttProvider = 'google';
  } else if (radioSttFunasr && radioSttFunasr.checked) {
    chosenSttProvider = 'funasr';
  }

  const configToSave = {
    goals: currentGoals,
    goalLogic: logic,
    llm: {
      baseUrl: inputLlmBaseUrl.value.trim() || 'https://api.deepseek.com',
      apiKey: inputLlmApiKey.value.trim() || 'sk-a1cb432e809a48f1887013e73f09d96b',
      model: inputLlmModel.value.trim() || 'deepseek-v4-flash',
      maxContextTokens: parseInt(inputLlmMaxTokens.value, 10) || 8192,
      compactRatio: parseFloat(inputLlmCompactRatio.value) || 0.6,
    },
    stt: {
      provider: chosenSttProvider,
      googleApiKey: inputSttGoogleKey.value.trim(),
      languageCode: inputSttLanguageCode.value.trim() || 'zh-CN',
      rollingWindowSec: parseInt(inputSttRollingWindow.value, 10) || 25,
      whisperModelSize: selectWhisperModel ? selectWhisperModel.value : 'small',
      sherpaEmbeddingModelType: selectSherpaModel ? selectSherpaModel.value : 'campplus',
    },
  };

  try {
    await (window as any).skipperAPI.saveConfig(configToSave);
    appendLog('✓ 目标与大模型/STT设置已全部保存', 'success');
    showToast('全部设置保存成功！', 'success');
  } catch (err: any) {
    appendLog(`保存设置失败: ${err?.message || err}`, 'error');
    showToast(`保存失败: ${err?.message || err}`, 'error');
  }
});

// ========================================================
// 4. Debug Tab & Independent Config Files
// ========================================================
btnSaveSystemPrompt.addEventListener('click', async () => {
  const sysPrompt = textareaSystemPrompt.value.trim();
  const compactPrompt = textareaCompactPrompt.value.trim();
  try {
    await (window as any).skipperAPI.savePrompts({
      systemPrompt: sysPrompt,
      compactPrompt: compactPrompt,
    });
    appendLog('✓ 系统提示词已保存到 skipper-prompts.json', 'success');
    showToast('系统提示词已保存');
  } catch (err: any) {
    showToast('保存提示词失败', 'error');
  }
});

btnSaveCompactPrompt.addEventListener('click', async () => {
  const sysPrompt = textareaSystemPrompt.value.trim();
  const compactPrompt = textareaCompactPrompt.value.trim();
  try {
    await (window as any).skipperAPI.savePrompts({
      systemPrompt: sysPrompt,
      compactPrompt: compactPrompt,
    });
    appendLog('✓ 压缩提示词已保存到 skipper-prompts.json', 'success');
    showToast('压缩提示词已保存');
  } catch (err: any) {
    showToast('保存提示词失败', 'error');
  }
});

btnSaveConstants.addEventListener('click', async () => {
  const constants = {
    pauseThresholdSec: parseFloat(inputConstantPauseThreshold.value) || 3.0,
    minIntervalSec: parseFloat(inputConstantMinInterval.value) || 10.0,
    maxIntervalSec: parseFloat(inputConstantMaxInterval.value) || 60.0,
    compactRatio: parseFloat(inputConstantCompactRatio.value) || 0.6,
  };

  try {
    await (window as any).skipperAPI.saveConstants(constants);
    appendLog('✓ 阈值常量已保存到 skipper-constants.json', 'success');
    showToast('阈值常量保存成功', 'success');
  } catch (err: any) {
    showToast('保存阈值常量失败', 'error');
  }
});

// ========================================================
// 5. Initial Configuration Population & Event Subscriptions
// ========================================================
async function initDashboard(): Promise<void> {
  try {
    const config = await (window as any).skipperAPI.getConfig();
    if (config) {
      // 1. Browser URL
      if (config.lastBrowserUrl) {
        inputBrowserUrl.value = config.lastBrowserUrl;
      }
      if (config.muteLocalAudio !== undefined) {
        checkboxMuteLocal.checked = config.muteLocalAudio;
      }

      // 2. Goals & Logic
      if (Array.isArray(config.goals)) {
        currentGoals = config.goals;
      }
      if (config.goalLogic === 'AND') {
        radioLogicAnd.checked = true;
        currentGoalLogic = 'AND';
      } else {
        radioLogicOr.checked = true;
        currentGoalLogic = 'OR';
      }
      renderGoals();

      // 3. LLM Config
      if (config.llm) {
        if (config.llm.baseUrl) inputLlmBaseUrl.value = config.llm.baseUrl;
        if (config.llm.apiKey) inputLlmApiKey.value = config.llm.apiKey;
        if (config.llm.model) inputLlmModel.value = config.llm.model;
        if (config.llm.maxContextTokens) inputLlmMaxTokens.value = String(config.llm.maxContextTokens);
        if (config.llm.compactRatio) {
          inputLlmCompactRatio.value = String(config.llm.compactRatio);
          inputConstantCompactRatio.value = String(config.llm.compactRatio);
        }
      }

      // 4. STT Config
      if (config.stt) {
        if (config.stt.provider === 'google') {
          radioSttGoogle.checked = true;
          sttGoogleContainer.style.display = 'flex';
        } else if (config.stt.provider === 'funasr') {
          if (radioSttFunasr) radioSttFunasr.checked = true;
          sttGoogleContainer.style.display = 'none';
        } else {
          radioSttCpu.checked = true;
          sttGoogleContainer.style.display = 'none';
        }
        if (config.stt.googleApiKey) inputSttGoogleKey.value = config.stt.googleApiKey;
        if (config.stt.languageCode) inputSttLanguageCode.value = config.stt.languageCode;
        if (config.stt.rollingWindowSec) inputSttRollingWindow.value = String(config.stt.rollingWindowSec);
        if (selectWhisperModel && config.stt.whisperModelSize) selectWhisperModel.value = config.stt.whisperModelSize;
        if (selectSherpaModel && config.stt.sherpaEmbeddingModelType) selectSherpaModel.value = config.stt.sherpaEmbeddingModelType;
      }

      // 5. Prompts
      if (config.prompts) {
        if (config.prompts.systemPrompt) textareaSystemPrompt.value = config.prompts.systemPrompt;
        if (config.prompts.compactPrompt) textareaCompactPrompt.value = config.prompts.compactPrompt;
      }

      // 6. Threshold Constants
      if (config.thresholds) {
        if (config.thresholds.pauseThresholdSec) {
          inputConstantPauseThreshold.value = String(config.thresholds.pauseThresholdSec);
        }
        if (config.thresholds.minIntervalSec) {
          inputConstantMinInterval.value = String(config.thresholds.minIntervalSec);
        }
        if (config.thresholds.maxIntervalSec) {
          inputConstantMaxInterval.value = String(config.thresholds.maxIntervalSec);
        }
      }
    }

    // Status sync
    const status = await (window as any).skipperAPI.getStatus();
    if (status) {
      updateStateBadge(status.state);
      if (status.isInitialized) {
        browserStatusTag.innerText = '已就绪 (视频播放中)';
        browserStatusTag.className = 'badge badge-success';
      }
    }

    // Load initial speaker tracks
    try {
      const initialTracks = await (window as any).skipperAPI.getSpeakerTracks?.();
      if (Array.isArray(initialTracks) && initialTracks.length > 0) {
        renderSpeakerTracks(initialTracks);
      }
    } catch {}
  } catch (err: any) {
    console.error('Failed to initialize dashboard config:', err);
  }
}

// Wire Event Listeners from SkipperAPI
(window as any).skipperAPI.onStatusUpdate((status: any) => {
  if (!status) return;
  updateStateBadge(status.state);
  if (status.isInitialized) {
    browserStatusTag.innerText = '已就绪 (视频播放中)';
    browserStatusTag.className = 'badge badge-success';
  }
});

(window as any).skipperAPI.onAudioLevel((level: number) => {
  updateAudioMeter(level);
});

(window as any).skipperAPI.onTranscriptSegment((seg: any) => {
  appendTranscriptSegment(seg);
});

(window as any).skipperAPI.onSpeakerTracksUpdated?.((tracks: any[]) => {
  renderSpeakerTracks(tracks);
});

(window as any).skipperAPI.onTeacherChanged?.((data: any) => {
  appendLog(`[主讲老师变更] 当前主讲: ${data.teacherId} (${data.isManual ? '用户指定' : 'AI自动判定: ' + (data.reason || '')})`, 'alert');
  showToast(`主讲老师已确定: ${data.teacherId}`, 'info');
  (window as any).skipperAPI.getSpeakerTracks?.().then((tracks: any[]) => {
    if (Array.isArray(tracks)) renderSpeakerTracks(tracks);
  }).catch(() => {});
});

(window as any).skipperAPI.onScreeningAlert((alert: any) => {
  alertBadge.innerText = '🚨 触发提醒';
  alertBadge.className = 'badge badge-warning';
  alertReason.innerText = alert.reason || '已达到预设关注目标';
  alertSummary.innerText = alert.summary || '当前知识点讲解结束或老师已开始下一环节';
  alertMatchedGoals.innerText = Array.isArray(alert.matchedGoals) ? alert.matchedGoals.join('; ') : String(alert.matchedGoals || '--');
  alertConfidence.innerText = alert.confidence ? `${Math.round(alert.confidence * 100)}%` : '95%';
  alertTime.innerText = new Date(alert.timestamp || Date.now()).toLocaleTimeString();

  appendLog(`🚨 [课堂提醒触发] ${alert.reason} - ${alert.summary}`, 'alert');
  showToast(`🔔 提醒: ${alert.reason}`, 'warning');
});

(window as any).skipperAPI.onEvaluationLog((log: any) => {
  const triggerTypeStr = log.triggerType === 'pause' ? '停顿触发' : log.triggerType === 'timeout' ? '超时强制' : '手动触发';
  const verdictStr = log.verdict?.triggered ? '🚨 满足条件触发' : '静默监控中';
  appendLog(`[LLM 评估 (${triggerTypeStr})] 耗时: ${log.durationMs}ms | 判定: ${verdictStr} | 主题: "${log.verdict?.currentTopic || '通用'}"`);
});

(window as any).skipperAPI.onUrlChanged((url: string) => {
  if (url && !url.startsWith('about:')) {
    inputBrowserUrl.value = url;
    appendLog(`直播页面导航: ${url}`);
  }
});

// Run dashboard initialization
initDashboard();
