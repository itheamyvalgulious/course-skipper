# Skipper - Agent Guidelines & Development Rules (agents.md)

## 1. 运行与调试环境约束 (Environment & Debugging Rules)
* **操作系统与终端调用**：
  * **本项目以 Windows 原生环境为主开发与调试环境**。
  * 在 WSL 或自动化 Agent 环境中触发命令时，**必须使用 Windows `cmd.exe`（或 PowerShell）调用**，例如：
    ```bash
    cmd.exe /c "cd /d C:\Projects\skipper && npm start"
    cmd.exe /c "cd /d C:\Projects\skipper && npm test"
    cmd.exe /c "cd /d C:\Projects\skipper && npm run build"
    ```
  * 项目物理根目录：`C:\Projects\skipper` (WSL 路径: `/mnt/c/Projects/skipper`)。

* **GPU 硬件加速原则**：
  * 本项目涉及高清课堂直播视频播放、页面渲染以及高频截屏，**严禁在生产或主程序中添加 `--disable-gpu` 等禁用硬件加速的参数**。
  * 必须充分利用 Windows 本地 GPU 驱动进行视频硬件解码与 Chromium Compositor 渲染，保证听课助手零卡顿。

---

## 2. 项目架构分层规范 (Architecture Rules)

本项目严格分为以下四个模块：

1. **输入层 (Input Layer - `src/core/input/`)**：
   * **初始化**：管理内置浏览器窗口（持久分区 `partition: 'persist:skipper-school'`、`backgroundThrottling: false`），用户直接在浏览器中登录和播放直播，通过交互标记就绪。
   * **抓图接口 (`getCurrentFrame`)**：基于 `webContents.capturePage()` 提取当前帧图像。
   * **抓音频接口 (`getAudioStream`)**：通过 `session.setDisplayMediaRequestHandler` 绑定直播页面的 `WebFrameMain`，开启 `enableLocalEcho: true`（保证扬声器同时发声），提取 16kHz PCM 音频流。

2. **动作层 (Action Layer - `src/core/action/`)**：
   * 负责响应系统提醒动作。
   * 目前支持系统原生桌面弹窗提醒（`Notification`），点击通知直接唤醒/置顶直播窗口；提供对话框（`dialog`）兜底。

3. **Provider 层 (AI Provider - `src/core/provider/`)**：
   * 封装与 AI 的所有交互逻辑（抽象接口 `IAIProvider`）。
   * `MockAIProvider` 用于本地测试与模拟识别；
   * `GeminiLiveProvider` 预留用于未来接入 Gemini Multimodal Live API（当前阶段暂不连接）。

4. **处理层 (Processing Layer - `src/core/processing/`)**：
   * 调度中枢，负责串联输入层（周期性抓图 + 音频管道）、Provider 与动作层。
   * 提供 `startMonitoring`, `pauseMonitoring`, `resumeMonitoring`, `stopMonitoring`, `setUserPrompt` 等控制接口。

---

## 3. 常用 Windows 命令参考
* **安装依赖**：`cmd.exe /c "cd /d C:\Projects\skipper && npm install"`
* **构建编译**：`cmd.exe /c "cd /d C:\Projects\skipper && npm run build"`
* **启动运行**：`cmd.exe /c "cd /d C:\Projects\skipper && npm start"`
