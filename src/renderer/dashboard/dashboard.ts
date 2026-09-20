// Skipper Dashboard Frontend Logic
interface Window {
  skipperAPI?: any;
}

// DOM Elements
const statusPill = document.getElementById('system-status-pill')!;
const statusText = document.getElementById('system-status-text')!;
const inputStatusTag = document.getElementById('input-status-tag')!;

const inputBrowserUrl = document.getElementById('browser-url') as HTMLInputElement;
const btnOpenBrowser = document.getElementById('btn-open-browser')!;
const btnCompleteInit = document.getElementById('btn-complete-init')!;
const btnToggleBrowserView = document.getElementById('btn-toggle-browser-view')!;
const btnLoadSample = document.getElementById('btn-load-sample')!;

const btnTestCapture = document.getElementById('btn-test-capture')!;
const previewPlaceholder = document.getElementById('preview-placeholder')!;
const previewImg = document.getElementById('preview-img') as HTMLImageElement;
const frameInfo = document.getElementById('frame-info')!;
const frameTime = document.getElementById('frame-time')!;

const btnToggleAudioCapture = document.getElementById('btn-toggle-audio-capture')!;
const checkboxMuteLocal = document.getElementById('checkbox-mute-local') as HTMLInputElement;
const audioMeterFill = document.getElementById('audio-meter-fill')!;
const audioMeterText = document.getElementById('audio-meter-text')!;
const audioStreamStatus = document.getElementById('audio-stream-status')!;
const audioChunkStats = document.getElementById('audio-chunk-stats')!;

const providerBadgeTag = document.getElementById('provider-badge-tag')!;
const providerModeTag = document.getElementById('provider-mode-tag')!;
const radioAIStudio = document.getElementById('mode-aistudio') as HTMLInputElement;
const radioVertex = document.getElementById('mode-vertex') as HTMLInputElement;
const radioMock = document.getElementById('mode-mock') as HTMLInputElement;

const aistudioContainer = document.getElementById('aistudio-config-container')!;
const vertexContainer = document.getElementById('vertex-config-container')!;

const inputApiKey = document.getElementById('gemini-api-key') as HTMLInputElement;
const btnSaveAIStudio = document.getElementById('btn-save-aistudio')!;

const inputVertexProject = document.getElementById('vertex-project') as HTMLInputElement;
const inputVertexLocation = document.getElementById('vertex-location') as HTMLInputElement;
const inputVertexApiKey = document.getElementById('vertex-api-key') as HTMLInputElement;
const btnSaveVertex = document.getElementById('btn-save-vertex')!;

const inputUserPrompt = document.getElementById('user-prompt') as HTMLInputElement;
const btnUpdatePrompt = document.getElementById('btn-update-prompt')!;
const selectModel = document.getElementById('select-model') as HTMLSelectElement;
const btnSaveModel = document.getElementById('btn-save-model')!;
const btnMockTrigger = document.getElementById('btn-mock-trigger')!;

const tokenTotalDisplay = document.getElementById('token-total-display')!;
const tokenPromptDisplay = document.getElementById('token-prompt-display')!;
const tokenResponseDisplay = document.getElementById('token-response-display')!;

const btnTestAction = document.getElementById('btn-test-action')!;
const lastNotificationDisplay = document.getElementById('last-notification-display')!;

const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnResume = document.getElementById('btn-resume') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const logContainer = document.getElementById('log-container')!;
const btnClearLog = document.getElementById('btn-clear-log')!;

// Audio Capturer State
let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let speakerGainNode: GainNode | null = null;
let isCapturingAudio = false;
let audioChunksCount = 0;
let isBrowserVisible = true;

// Logger
function appendLog(text: string, highlight: boolean = false) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="${highlight ? 'log-highlight' : ''}">${text}</span>`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Update State UI
function updateStateBadge(state: string) {
  statusPill.className = `status-badge status-${state}`;
  const stateLabels: Record<string, string> = {
    idle: '未初始化 (IDLE)',
    initializing: '初始化中 (INITIALIZING)',
    ready: '已就绪 (READY)',
    monitoring: '监控中 (MONITORING)',
    paused: '已暂停 (PAUSED)',
    error: '错误 (ERROR)',
  };
  statusText.innerText = stateLabels[state] || state.toUpperCase();

  // Control button states
  if (state === 'monitoring') {
    btnStart.style.display = 'none';
    btnResume.style.display = 'none';
    btnPause.style.display = 'inline-flex';
    btnPause.disabled = false;
    btnStop.disabled = false;
  } else if (state === 'paused') {
    btnStart.style.display = 'none';
    btnPause.style.display = 'none';
    btnResume.style.display = 'inline-flex';
    btnResume.disabled = false;
    btnStop.disabled = false;
  } else if (state === 'ready') {
    btnStart.style.display = 'inline-flex';
    btnStart.disabled = false;
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnStop.disabled = true;
  } else {
    btnStart.style.display = 'inline-flex';
    btnStart.disabled = state === 'idle' || state === 'initializing';
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnStop.disabled = true;
  }
}

// Update Token Usage Display
function updateTokenDisplay(usage: any) {
  if (!usage) return;
  const total = usage.totalTokenCount || 0;
  const prompt = usage.promptTokenCount || 0;
  const resp = usage.responseTokenCount || 0;

  tokenTotalDisplay.innerText = `总计: ${total} tokens`;

  let audioTok = 0;
  let imageTok = 0;
  let textTok = 0;

  if (Array.isArray(usage.promptTokensDetails)) {
    for (const d of usage.promptTokensDetails) {
      if (d.modality === 'AUDIO') audioTok = d.tokenCount || 0;
      else if (d.modality === 'IMAGE') imageTok = d.tokenCount || 0;
      else if (d.modality === 'TEXT') textTok = d.tokenCount || 0;
    }
  }

  tokenPromptDisplay.innerText = `输入: ${prompt} (音频: ${audioTok}, 画面: ${imageTok}, 文本: ${textTok})`;
  tokenResponseDisplay.innerText = `输出: ${resp}`;
}

// Audio Capture Implementation
async function startAudioCapture(): Promise<boolean> {
  if (isCapturingAudio) return true;

  try {
    appendLog('正在启动 WebFrameMain 音频捕获 (getDisplayMedia)...');
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      appendLog('警告: 未捕获到音频轨，请确认目标窗口是否有音频播放', true);
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

      audioChunksCount++;
      audioChunkStats.innerText = `接收数据包: ${audioChunksCount}`;

      // Send to main process via IPC
      window.skipperAPI.sendAudioChunk(pcm16.buffer, rms);

      // Update local meter
      updateAudioMeter(rms);
    };

    // 1) Processing path: Connect processor to silent node (so processor keeps running without audio doubling)
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

    // 2) Speaker path: Dedicated gain node for physical speaker playback
    // If checkbox is checked (muted), gain is 0; otherwise gain is 1.
    speakerGainNode = audioContext.createGain();
    speakerGainNode.gain.value = checkboxMuteLocal.checked ? 0 : 1;
    source.connect(speakerGainNode);
    speakerGainNode.connect(audioContext.destination);

    isCapturingAudio = true;
    audioStreamStatus.innerText = '状态: 采集流运行中';
    audioStreamStatus.style.color = '#4ade80';
    btnToggleAudioCapture.innerText = '⏹ 停止音频采集';
    appendLog('✓ 音频采集管道建立成功 (16kHz PCM mono 流已接通)', true);
    return true;
  } catch (err: any) {
    appendLog(`音频捕获失败: ${err.message || err}`, true);
    console.error('Audio capture error:', err);
    return false;
  }
}

function stopAudioCapture(): void {
  if (!isCapturingAudio) return;

  if (speakerGainNode) {
    speakerGainNode.disconnect();
    speakerGainNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  isCapturingAudio = false;
  audioStreamStatus.innerText = '状态: 已停止';
  audioStreamStatus.style.color = '#94a3b8';
  btnToggleAudioCapture.innerText = '🎙 激活音频采集';
  updateAudioMeter(0);
  appendLog('音频采集流已停止');
}

function updateAudioMeter(level: number) {
  const percent = Math.min(100, Math.round(level * 300));
  audioMeterFill.style.width = `${percent}%`;
  audioMeterText.innerText = `${percent}%`;
}

// Wire UI Event Listeners
btnOpenBrowser.addEventListener('click', async () => {
  const url = inputBrowserUrl.value.trim();
  appendLog(`正在打开内置直播浏览器... ${url ? `目标网址: ${url}` : '默认空白页'}`);
  await window.skipperAPI.openBrowser(url || undefined);
  inputStatusTag.innerText = '浏览器已打开 (请登录/播放)';
  inputStatusTag.style.background = '#0369a1';
  inputStatusTag.style.color = '#e0f2fe';
});

btnLoadSample.addEventListener('click', async () => {
  const sampleUrl = 'file:///C:/Projects/skipper/test-assets/player.html';
  inputBrowserUrl.value = sampleUrl;
  appendLog(`正在加载 10分钟测试样例视频: ${sampleUrl}...`, true);
  await window.skipperAPI.openBrowser(sampleUrl);
  inputStatusTag.innerText = '测试样例已加载 (请开始播放)';
  inputStatusTag.style.background = '#0369a1';
  inputStatusTag.style.color = '#e0f2fe';
});

btnToggleBrowserView.addEventListener('click', async () => {
  if (isBrowserVisible) {
    await window.skipperAPI.hideBrowser();
    isBrowserVisible = false;
    btnToggleBrowserView.innerText = '👁 显示浏览器';
    appendLog('直播浏览器已隐藏到后台 (页面继续无油门运行)');
  } else {
    await window.skipperAPI.showBrowser();
    isBrowserVisible = true;
    btnToggleBrowserView.innerText = '👁 隐藏浏览器';
    appendLog('直播浏览器已恢复前台显示');
  }
});

btnCompleteInit.addEventListener('click', async () => {
  appendLog('用户触发【完成初始化】交互...');
  // Start audio capture directly within user click gesture
  await startAudioCapture();
  await window.skipperAPI.completeInitialization();
  inputStatusTag.innerText = '初始化完成 (已就绪)';
  inputStatusTag.style.background = '#15803d';
  inputStatusTag.style.color = '#dcfce7';
  appendLog('✓ 输入层初始化完成！可以开始开启监控', true);
});

btnTestCapture.addEventListener('click', async () => {
  appendLog('执行单次抓图测试 (webContents.capturePage)...');
  const frame = await window.skipperAPI.captureSingleFrame();
  if (frame) {
    renderFrame(frame);
    appendLog(`✓ 抓图成功: ${frame.width}x${frame.height}, 时间戳: ${frame.timestamp}`);
  } else {
    appendLog('抓图失败，请确保内置浏览器窗口已打开', true);
  }
});

btnToggleAudioCapture.addEventListener('click', async () => {
  if (isCapturingAudio) {
    stopAudioCapture();
  } else {
    await startAudioCapture();
  }
});

checkboxMuteLocal.addEventListener('change', async () => {
  const muted = checkboxMuteLocal.checked;
  if (speakerGainNode && audioContext) {
    try {
      speakerGainNode.gain.setValueAtTime(muted ? 0 : 1, audioContext.currentTime);
    } catch (e) {
      speakerGainNode.gain.value = muted ? 0 : 1;
    }
  }
  await window.skipperAPI.setMuteLocal(muted);
  appendLog(
    muted
      ? '🔇 已开启本地静音 (电脑扬声器不发声，音频仅传给 AI 监听)'
      : '🔊 已开启本地扬声器播放 (您可以直接在电脑上听到直播声音)',
    true
  );
});

// Helper to update Provider UI view mode
function setUIMode(mode: 'aistudio' | 'vertex' | 'mock') {
  if (mode === 'aistudio') {
    radioAIStudio.checked = true;
    aistudioContainer.style.display = 'block';
    vertexContainer.style.display = 'none';
    providerModeTag.innerText = 'Google AI Studio (Gemini Developer API)';
    providerModeTag.style.background = '#1e3a8a';
    providerModeTag.style.color = '#93c5fd';
  } else if (mode === 'vertex') {
    radioVertex.checked = true;
    aistudioContainer.style.display = 'none';
    vertexContainer.style.display = 'block';
    providerModeTag.innerText = 'Google Cloud Vertex AI';
    providerModeTag.style.background = '#581c87';
    providerModeTag.style.color = '#e9d5ff';
  } else {
    radioMock.checked = true;
    aistudioContainer.style.display = 'none';
    vertexContainer.style.display = 'none';
    providerModeTag.innerText = 'Mock 演练模式';
    providerModeTag.style.background = '#065f46';
    providerModeTag.style.color = '#a7f3d0';
  }
}

// Mode Toggle Handlers
radioAIStudio.addEventListener('change', async () => {
  if (radioAIStudio.checked) {
    setUIMode('aistudio');
    await window.skipperAPI.setBackendType('aistudio');
    appendLog('[Provider] 已切换为 Google AI Studio 模式 (Gemini Developer API)', true);
  }
});

radioVertex.addEventListener('change', async () => {
  if (radioVertex.checked) {
    setUIMode('vertex');
    await window.skipperAPI.setBackendType('vertex');
    appendLog('[Provider] 已切换为 Google Cloud Vertex AI 模式', true);
  }
});

radioMock.addEventListener('change', async () => {
  if (radioMock.checked) {
    setUIMode('mock');
    await window.skipperAPI.setBackendType('mock');
    appendLog('[Provider] 已切换到本地 Mock Live Server (10s 自动演练模式)', true);
  }
});

btnSaveAIStudio.addEventListener('click', async () => {
  const key = inputApiKey.value.trim();
  await window.skipperAPI.setProviderConfig({
    backendType: 'aistudio',
    apiKey: key,
  });
  appendLog(`✓ AI Studio API Key 已保存 (长度: ${key.length})`, true);
});

btnSaveVertex.addEventListener('click', async () => {
  const project = inputVertexProject.value.trim();
  const location = inputVertexLocation.value.trim() || 'us-central1';
  const apiKey = inputVertexApiKey.value.trim();

  await window.skipperAPI.setProviderConfig({
    backendType: 'vertex',
    project,
    location,
    apiKey: apiKey || undefined,
  });
  appendLog(`✓ Vertex AI 配置已保存: Project="${project || '(ADC/默认)'}", Location="${location}"`, true);
});

btnSaveModel.addEventListener('click', async () => {
  const model = selectModel.value.trim();
  await window.skipperAPI.setModel(model);
  appendLog(`✓ Live 模型已切换为: "${model}"`, true);
});

btnUpdatePrompt.addEventListener('click', async () => {
  const prompt = inputUserPrompt.value.trim();
  if (!prompt) return;
  await window.skipperAPI.setUserPrompt(prompt);
  appendLog(`已更新叫我条件 (sendClientContent): "${prompt}"`, true);
});

btnMockTrigger.addEventListener('click', async () => {
  const prompt = inputUserPrompt.value.trim() || '目标知识点讲解完毕';
  appendLog(`[Provider] 模拟触发 notify_user tool call: "${prompt}"...`);
  await window.skipperAPI.mockTriggerNotification(
    '目标知识点讲解完毕',
    `【AI 观察】当前黑板公式已推导结束，老师开始翻页。符合用户条件: "${prompt}"`
  );
});

btnTestAction.addEventListener('click', async () => {
  appendLog('[ActionLayer] 测试桌面弹窗通知接口...');
  await window.skipperAPI.testNotification('测试提醒', 'Skipper 动作层接口工作正常！');
});

btnStart.addEventListener('click', async () => {
  const prompt = inputUserPrompt.value.trim();
  appendLog(`🚀 启动处理层监控管道... 条件: "${prompt}"`);
  if (!isCapturingAudio) {
    await startAudioCapture();
  }
  await window.skipperAPI.startMonitoring(prompt);
  appendLog('✓ 监控已启动 (每 2.5s 周期截图 + 音频连续流传输)', true);
});

btnPause.addEventListener('click', async () => {
  appendLog('⏸ 正在暂停监控...');
  await window.skipperAPI.pauseMonitoring();
  appendLog('监控已暂停');
});

btnResume.addEventListener('click', async () => {
  appendLog('▶ 正在恢复监控...');
  await window.skipperAPI.resumeMonitoring();
  appendLog('监控已恢复');
});

btnStop.addEventListener('click', async () => {
  appendLog('⏹ 正在停止监控...');
  await window.skipperAPI.stopMonitoring();
  stopAudioCapture();
  appendLog('监控已停止');
});

btnClearLog.addEventListener('click', () => {
  logContainer.innerHTML = '';
});

// Render incoming frame preview
function renderFrame(frame: any) {
  if (!frame || !frame.dataUrl) return;
  previewPlaceholder.style.display = 'none';
  previewImg.style.display = 'block';
  previewImg.src = frame.dataUrl;
  frameInfo.innerText = `分辨率: ${frame.width}x${frame.height}`;
  frameTime.innerText = `时间: ${new Date(frame.timestamp).toLocaleTimeString()}`;
}

// Real-time event listeners from SkipperAPI
window.skipperAPI.onStatusUpdate((status: any) => {
  if (!status) return;
  updateStateBadge(status.state);

  if (status.isInitialized) {
    inputStatusTag.innerText = '已就绪 (Ready)';
    inputStatusTag.style.background = '#15803d';
    inputStatusTag.style.color = '#dcfce7';
  }

  if (status.lastNotification) {
    const notif = status.lastNotification;
    lastNotificationDisplay.innerHTML = `
      <b style="color: #f87171;">${notif.title}</b><br>
      <span>${notif.body}</span><br>
      <small style="color: #94a3b8;">${new Date(notif.timestamp).toLocaleTimeString()}</small>
    `;
  }
});

window.skipperAPI.onFrameProcessed((frame: any) => {
  renderFrame(frame);
});

window.skipperAPI.onAudioLevel((level: number) => {
  updateAudioMeter(level);
});

window.skipperAPI.onNotification((notif: any) => {
  appendLog(`🔔 [动作层通知] ${notif.title} - ${notif.body}`, true);
  lastNotificationDisplay.innerHTML = `
    <b style="color: #f87171;">${notif.title}</b><br>
    <span>${notif.body}</span><br>
    <small style="color: #94a3b8;">${new Date().toLocaleTimeString()}</small>
  `;
});

window.skipperAPI.onUsageMetadata((usage: any) => {
  updateTokenDisplay(usage);
  appendLog(
    `📊 [Token 消耗] 总计: ${usage.totalTokenCount} (Prompt: ${usage.promptTokenCount}, Resp: ${usage.responseTokenCount})`
  );
});

window.skipperAPI.onProviderStatus((status: string) => {
  appendLog(`[Provider 状态变更] -> ${status}`);
  if (status === 'connected') {
    providerBadgeTag.innerText = 'Gemini Live 连接就绪';
    providerBadgeTag.style.background = '#15803d';
    providerBadgeTag.style.color = '#dcfce7';
  } else if (status === 'disconnected') {
    providerBadgeTag.innerText = '已断开连接';
    providerBadgeTag.style.background = '#475569';
    providerBadgeTag.style.color = '#cbd5e1';
  }
});

window.skipperAPI.onProviderError((err: string) => {
  appendLog(`[Provider 错误] ${err}`, true);
});

window.skipperAPI.onUrlChanged((url: string) => {
  if (url && !url.startsWith('about:')) {
    inputBrowserUrl.value = url;
    appendLog(`[浏览器导航] 当前直播页面: ${url}`);
  }
});

// Initial fetch and persistent configuration restoration
window.skipperAPI.getStatus().then((status: any) => {
  if (status) {
    updateStateBadge(status.state);

    const config = status.config || {};

    if (config.lastBrowserUrl) {
      inputBrowserUrl.value = config.lastBrowserUrl;
    }

    if (config.muteLocalAudio !== undefined) {
      checkboxMuteLocal.checked = config.muteLocalAudio;
    }

    if (status.userPrompt || config.userPrompt) {
      inputUserPrompt.value = status.userPrompt || config.userPrompt;
    }

    if (config.apiKey) {
      inputApiKey.value = config.apiKey;
    }

    if (config.vertexProject) {
      inputVertexProject.value = config.vertexProject;
    }

    if (config.vertexLocation) {
      inputVertexLocation.value = config.vertexLocation;
    }

    if (config.vertexApiKey) {
      inputVertexApiKey.value = config.vertexApiKey;
    }

    const currentModel = config.model || status.provider?.model;
    if (currentModel) {
      selectModel.value = currentModel;
    }

    const currentMode = config.backendType || status.provider?.backendType || (status.provider?.useMockServer ? 'mock' : 'aistudio');
    setUIMode(currentMode);

    if (status.provider?.stats?.usage) {
      updateTokenDisplay(status.provider.stats.usage);
    }
  }
});

