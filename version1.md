# Skipper.md

这个项目一阶段目标是
通过学校直播平台获取课堂实时视频+音频数据 以实现 每当老师开始讲一个新的知识点的时候 提醒用户
本质定位是 用户的听课助手
后续可以考虑支持如 自动笔记 自动答疑 等后续功能.



### 初版技术方案


第一版建议尽量压缩成 **Electron + Gemini 3.8 Live + 系统通知**，先验证“能不能放心把课堂交给它监控”，暂时不做 ASR/OCR/知识点树。

```text
Electron 内嵌学校直播
   ├─ 页面音频 ──────────┐
   └─ 每 2~3 秒截图 ─────┤
                         ↓
                  Gemini 3.8 Live
                         ↓
              用户自然语言条件
        “这个证明结束以后叫我”
                         ↓
                  notify() tool
                         ↓
                    系统通知
```

**Gemini Live**：建立一个持续 session，把直播音频连续发送，同时周期性发送截图；用户输入“这题做完叫我”“只要还在讲 Fatou 就别叫我”等要求也发送到同一个 session。`gemini-3.8-live` 原生支持音频、图片/视频输入和 function calling，所以给它注册一个 `notify(reason, summary)` 工具即可。大部分时间模型只观察；判断条件满足时调用工具。:chatgpt-content-reference{index="0"}

**Electron 抓屏**：用独立 `BrowserWindow/WebContents` 打开学校平台，使用持久 partition 保存登录状态，并关闭 `backgroundThrottling`，这样窗口隐藏后页面仍继续运行。画面直接调用 `webContents.capturePage()`，它支持隐藏页面截图；第一版每 2~3 秒截一次 JPEG 即可，之后再加 PPT 区域裁剪和变化检测。:chatgpt-content-reference{index="1"}

**音频**不要录整个系统。Electron 的 `setDisplayMediaRequestHandler` 可以把直播页面对应的 `WebFrameMain` 直接作为 audio source，从而只捕获这个 WebContents 的声音；采集 renderer 用 `getDisplayMedia()` 获得 `MediaStream`，再转换成 Gemini Live 所需的音频流。:chatgpt-content-reference{index="2"}

这样第一版真正需要实现的核心只有：**登录浏览器、页面音频采集、周期截图、Live session、一个提醒工具和一个“什么时候叫我”的输入框**。
