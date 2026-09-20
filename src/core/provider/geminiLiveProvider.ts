import { WebSocket } from 'ws';
import { GoogleGenAI, Modality, Behavior, FunctionResponseScheduling } from '@google/genai';
import { BaseAIProvider } from './baseProvider';
import { AIProviderConfig, AIBackendType, TokenUsageMetadata } from './types';

const DEFAULT_SYSTEM_INSTRUCTION = `
You are monitoring a university lecture.

The user will give you a condition describing when they want
to return their attention to the lecture.

Examples:
- "Notify me when this proof ends."
- "Notify me when this problem is finished."
- "Don't notify me while the professor is discussing Fatou's lemma."
- "Notify me when the professor starts a new topic."

Continuously understand the lecture from audio and screenshots.

IMPORTANT:
- Do not speak or respond to ordinary lecture content.
- Stay silent while the wake condition is not satisfied.
- Be conservative: false notifications are worse than slightly late notifications.
- When you are confident the wake condition has been satisfied,
  call notify_user.
`;

const NOTIFY_TOOL_DECLARATION = {
  name: 'notify_user',
  description: 'Call this function ONLY when the user\'s current wake-up condition has clearly been satisfied.',
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why the user should return to the lecture',
      },
      summary: {
        type: 'string',
        description: 'A short summary of what the user skipped',
      },
      current_topic: {
        type: 'string',
        description: 'What the professor is discussing now',
      },
    },
    required: ['reason'],
  },
};

/**
 * Robust helper to safely convert various binary inputs (Buffer, Uint8Array, ArrayBuffer, comma-separated string)
 * into a valid Node.js Buffer.
 */
export function toBuffer(input: any): Buffer {
  if (!input) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }
  if (typeof input === 'string') {
    // If it's a comma-separated decimal bytes string e.g. "23,255,40,..."
    if (/^\s*\d+(\s*,\s*\d+)*\s*$/.test(input)) {
      const numbers = input.split(',').map((n) => parseInt(n.trim(), 10));
      return Buffer.from(numbers);
    }
    return Buffer.from(input, 'base64');
  }
  if (Array.isArray(input)) {
    return Buffer.from(input);
  }
  return Buffer.from(input);
}

/**
 * Robust helper to convert binary inputs directly to a valid Base64 string.
 */
export function toBase64(input: any): string {
  if (!input) return '';
  if (typeof input === 'string') {
    if (/^\s*\d+(\s*,\s*\d+)*\s*$/.test(input)) {
      const numbers = input.split(',').map((n) => parseInt(n.trim(), 10));
      return Buffer.from(numbers).toString('base64');
    }
    return input;
  }
  return toBuffer(input).toString('base64');
}

export class GeminiLiveProvider extends BaseAIProvider {
  public readonly name: string = 'GeminiLiveProvider';

  private aiClient: GoogleGenAI | null = null;
  private liveSession: any = null;
  private wsClient: WebSocket | null = null;

  private backendType: AIBackendType = 'aistudio';
  private apiKey: string = '';
  private model: string = 'gemini-3.8-live';
  private vertexProject: string = '';
  private vertexLocation: string = 'us-central1';

  private useMockServer: boolean = false;
  private mockEndpoint: string = 'ws://127.0.0.1:8089';

  private resumeHandle: string | null = null;
  private isReconnecting: boolean = false;
  private lastSentPrompt: string | null = null;

  private frameCount: number = 0;
  private audioBytesReceived: number = 0;
  private lastUsage?: TokenUsageMetadata;

  constructor(config?: AIProviderConfig) {
    super(config);

    this.apiKey = config?.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = config?.model || 'gemini-3.8-live';
    this.vertexProject =
      config?.vertexProject || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
    this.vertexLocation =
      config?.vertexLocation || process.env.GOOGLE_CLOUD_LOCATION || process.env.GCP_LOCATION || 'us-central1';

    if (config?.backendType) {
      this.backendType = config.backendType;
    } else if (config?.useMockServer || (!this.apiKey && !this.vertexProject && config?.endpoint)) {
      this.backendType = 'mock';
    } else if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || config?.vertexProject) {
      this.backendType = 'vertex';
    } else {
      this.backendType = 'aistudio';
    }

    this.useMockServer = this.backendType === 'mock';
    this.mockEndpoint = config?.endpoint || process.env.MOCK_LIVE_ENDPOINT || 'ws://127.0.0.1:8089';
  }

  public setBackendType(type: AIBackendType): void {
    this.backendType = type;
    this.useMockServer = type === 'mock';
    this.config.backendType = type;
    this.config.useMockServer = this.useMockServer;
    console.log(`[GeminiLiveProvider] Backend mode switched to: ${this.backendType}`);
  }

  public getBackendType(): AIBackendType {
    return this.backendType;
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey.trim();
    this.config.apiKey = this.apiKey;
    console.log(`[GeminiLiveProvider] Updated API Key (length: ${this.apiKey.length})`);
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public setVertexConfig(project?: string, location?: string): void {
    if (project !== undefined) {
      this.vertexProject = project.trim();
      this.config.vertexProject = this.vertexProject;
    }
    if (location !== undefined) {
      this.vertexLocation = location.trim();
      this.config.vertexLocation = this.vertexLocation;
    }
    console.log(
      `[GeminiLiveProvider] Updated Vertex AI config: project="${this.vertexProject}", location="${this.vertexLocation}"`
    );
  }

  public getVertexConfig(): { project: string; location: string } {
    return {
      project: this.vertexProject,
      location: this.vertexLocation,
    };
  }

  public setModel(model: string): void {
    this.model = model.trim();
    this.config.model = this.model;
    console.log(`[GeminiLiveProvider] Updated Model to "${this.model}"`);
  }

  public setUseMockServer(useMock: boolean, endpoint?: string): void {
    this.useMockServer = useMock;
    this.backendType = useMock ? 'mock' : (this.vertexProject ? 'vertex' : 'aistudio');
    if (endpoint) {
      this.mockEndpoint = endpoint;
    }
    this.config.useMockServer = useMock;
    this.config.backendType = this.backendType;
    this.config.endpoint = this.mockEndpoint;
    console.log(`[GeminiLiveProvider] useMockServer set to ${useMock} (backend: ${this.backendType})`);
  }

  public setProviderConfig(options: {
    backendType?: AIBackendType;
    apiKey?: string;
    project?: string;
    location?: string;
    endpoint?: string;
    model?: string;
  }): void {
    if (options.backendType) {
      this.setBackendType(options.backendType);
    }
    if (options.apiKey !== undefined) {
      this.setApiKey(options.apiKey);
    }
    if (options.project !== undefined || options.location !== undefined) {
      this.setVertexConfig(options.project, options.location);
    }
    if (options.endpoint !== undefined) {
      this.mockEndpoint = options.endpoint;
      this.config.endpoint = this.mockEndpoint;
    }
    if (options.model !== undefined) {
      this.setModel(options.model);
    }
  }

  public getProviderInfo() {
    return {
      name: this.name,
      backendType: this.backendType,
      model: this.model,
      apiKeyConfigured: Boolean(this.apiKey),
      vertexProject: this.vertexProject,
      vertexLocation: this.vertexLocation,
      mockEndpoint: this.mockEndpoint,
      connected: this.connected,
      stats: this.getStats(),
    };
  }

  public isUsingMockServer(): boolean {
    return this.backendType === 'mock';
  }

  /**
   * Connect to the AI service (Google AI Studio, Google Cloud Vertex AI, or Mock Server)
   */
  public async connect(): Promise<void> {
    if (this.connected) {
      console.log('[GeminiLiveProvider] Already connected');
      return;
    }

    console.log(`[GeminiLiveProvider] Connecting... Backend Mode: ${this.backendType}`);

    if (this.backendType === 'mock') {
      // Connect to local or custom Mock Live WebSocket Server
      await this.connectToMockServer();
    } else {
      // Connect to Google Gemini Live API (AI Studio or Vertex AI)
      await this.connectToGoogleLive();
    }
  }

  /**
   * Disconnect the Live session
   */
  public async disconnect(): Promise<void> {
    if (this.liveSession) {
      try {
        this.liveSession.close();
      } catch (err) {
        console.error('[GeminiLiveProvider] Error closing liveSession:', err);
      }
      this.liveSession = null;
    }

    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch (err) {
        console.error('[GeminiLiveProvider] Error closing wsClient:', err);
      }
      this.wsClient = null;
    }

    this.connected = false;
    this.lastSentPrompt = null;
    this.emit('statusChange', 'disconnected');
    console.log('[GeminiLiveProvider] Disconnected');
  }

  /**
   * Update wake condition prompt (idempotent, deduplicated)
   */
  public setUserPrompt(prompt: string): void {
    super.setUserPrompt(prompt);

    if (!this.connected) return;
    if (this.lastSentPrompt === prompt) return;

    this.sendWakeCondition(prompt);
  }

  /**
   * Transmit wake condition turn to active Live session
   */
  private sendWakeCondition(prompt: string): void {
    const wakeConditionText = `My current wake-up condition is:\n\n${prompt}\n\nReplace any previous wake-up condition with this one.`;

    if (this.liveSession) {
      try {
        this.liveSession.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [{ text: wakeConditionText }],
            },
          ],
          turnComplete: true,
        });
        this.lastSentPrompt = prompt;
        console.log('[GeminiLiveProvider] Sent wake condition update to Gemini Live session');
      } catch (err) {
        console.error('[GeminiLiveProvider] Error sending wake condition:', err);
      }
    } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      try {
        this.wsClient.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  role: 'user',
                  parts: [{ text: wakeConditionText }],
                },
              ],
              turnComplete: true,
            },
          })
        );
        this.lastSentPrompt = prompt;
        console.log('[GeminiLiveProvider] Sent wake condition update to Mock Server');
      } catch (err) {
        console.error('[GeminiLiveProvider] Error sending wake condition to mock server:', err);
      }
    }
  }

  /**
   * Periodic heartbeat prompt (every 10s) to trigger model reasoning and tool evaluation
   * on the continuous audio/visual stream in Gemini Live.
   */
  public async sendHeartbeat(): Promise<void> {
    if (!this.connected) return;

    const condition = this.currentPrompt || '满足提醒条件';
    const heartbeatText = `[Heartbeat Evaluation]
Check if the user's wake-up condition has clearly been met:
Condition: "${condition}"

Strict Instructions:
- If and ONLY IF the condition is satisfied right now based on recent lecture audio and video, call the notify_user tool immediately.
- If the condition is not satisfied or is ongoing, remain completely SILENT (do not output any text or audio).`;

    if (this.liveSession) {
      try {
        this.liveSession.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [{ text: heartbeatText }],
            },
          ],
          turnComplete: true,
        });
        console.log('[GeminiLiveProvider] 💓 Sent 10s heartbeat evaluation prompt to Gemini Live session');
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending heartbeat:', err?.message);
      }
    } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      try {
        this.wsClient.send(
          JSON.stringify({
            clientContent: {
              turns: [
                {
                  role: 'user',
                  parts: [{ text: heartbeatText }],
                },
              ],
              turnComplete: true,
            },
          })
        );
        console.log('[GeminiLiveProvider] 💓 Sent 10s heartbeat evaluation prompt to Mock Server');
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending heartbeat to mock server:', err?.message);
      }
    }
  }

  /**
   * Send a video/presentation frame image (JPEG or PNG)
   */
  public async sendFrame(imageBuffer: Buffer | Uint8Array | ArrayBuffer, mimeType: string = 'image/jpeg'): Promise<void> {
    if (!this.connected) return;

    this.frameCount++;
    const base64Data = toBase64(imageBuffer);

    if (this.liveSession) {
      try {
        this.liveSession.sendRealtimeInput({
          video: {
            data: base64Data,
            mimeType: mimeType || 'image/jpeg',
          },
        });
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending frame to Gemini Live:', err.message);
      }
    } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      try {
        this.wsClient.send(
          JSON.stringify({
            realtimeInput: {
              video: {
                data: base64Data,
                mimeType: mimeType || 'image/jpeg',
              },
            },
          })
        );
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending frame to Mock Server:', err.message);
      }
    }
  }

  /**
   * Send a 16kHz PCM audio chunk
   */
  public async sendAudioChunk(chunk: Buffer | Uint8Array | ArrayBuffer): Promise<void> {
    if (!this.connected) return;

    const buf = toBuffer(chunk);
    this.audioBytesReceived += buf.length;
    const base64Audio = buf.toString('base64');

    if (this.liveSession) {
      try {
        this.liveSession.sendRealtimeInput({
          audio: {
            data: base64Audio,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending audio chunk to Gemini Live:', err.message);
      }
    } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      try {
        this.wsClient.send(
          JSON.stringify({
            realtimeInput: {
              audio: {
                data: base64Audio,
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          })
        );
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending audio chunk to Mock Server:', err.message);
      }
    }
  }

  public getStats(): { frames: number; audioBytes: number; usage?: TokenUsageMetadata } {
    return {
      frames: this.frameCount,
      audioBytes: this.audioBytesReceived,
      usage: this.lastUsage,
    };
  }

  /**
   * Connect to official Google Gemini Live API via @google/genai SDK
   * Supports both Google AI Studio (Gemini Developer API) and Google Cloud Vertex AI
   */
  private async connectToGoogleLive(): Promise<void> {
    const isVertex = this.backendType === 'vertex';
    console.log(
      `[GeminiLiveProvider] Initializing ${isVertex ? 'Google Cloud Vertex AI' : 'Google AI Studio (Gemini Developer API)'}...`
    );

    if (isVertex) {
      const options: any = {
        vertexai: true,
      };
      if (this.vertexProject) {
        options.project = this.vertexProject;
      }
      if (this.vertexLocation) {
        options.location = this.vertexLocation;
      }
      if (this.apiKey) {
        options.apiKey = this.apiKey;
      }

      this.aiClient = new GoogleGenAI(options);
      console.log(
        `[GeminiLiveProvider] Vertex AI options: project="${this.vertexProject || '(env/adc)'}", location="${this.vertexLocation}"`
      );
    } else {
      if (!this.apiKey) {
        throw new Error(
          'GeminiLiveProvider: GEMINI_API_KEY is not set for Google AI Studio mode. Please provide an API key in settings or environment variables.'
        );
      }

      this.aiClient = new GoogleGenAI({
        apiKey: this.apiKey,
        vertexai: false,
      });
      console.log(`[GeminiLiveProvider] AI Studio options: apiKey length=${this.apiKey.length}`);
    }

    const liveConfig: any = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: this.config.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION,
      tools: [
        {
          functionDeclarations: [NOTIFY_TOOL_DECLARATION],
        },
      ],
      contextWindowCompression: {
        triggerTokens: '25000',
        slidingWindow: {
          targetTokens: '8000',
        },
      },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };

    console.log(
      `[GeminiLiveProvider] Establishing Live session with model "${this.model}" on ${isVertex ? 'Vertex AI' : 'AI Studio'}...`
    );

    try {
      this.liveSession = await this.aiClient.live.connect({
        model: this.model,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            console.log('[GeminiLiveProvider] Gemini Live connected successfully');
            this.connected = true;
            this.lastSentPrompt = null;
            this.emit('statusChange', 'connected');

            // Send initial user wake prompt
            if (this.currentPrompt) {
              this.sendWakeCondition(this.currentPrompt);
            }
          },
          onmessage: (message: any) => {
            this.handleGeminiLiveMessage(message);
          },
          onerror: (error: any) => {
            console.error('[GeminiLiveProvider] Gemini Live error:', error);
            this.emit('error', error);
          },
          onclose: (event: any) => {
            const reason = event?.reason || String(event);
            console.log('[GeminiLiveProvider] Gemini Live session closed:', reason);
            if (
              this.backendType === 'vertex' &&
              (reason.includes('aiplatform.googleapis.com') ||
                this.vertexProject.startsWith('gen-lang-client') ||
                reason.includes('blocked') ||
                reason.includes('not supported'))
            ) {
              console.warn(
                '[GeminiLiveProvider] 💡 提示: "gen-lang-client-..." 是 Google AI Studio 生成的内置项目。\n' +
                '如果您使用的是从 Google AI Studio 获取的 API Key，请在控制台中将模式切换为【🔵 Google AI Studio (API Key)】即可正常使用！\n' +
                '【🟣 Google Cloud Vertex AI】仅适用于开启了 Vertex AI API 的 Google Cloud 企业项目。'
              );
            }
            this.connected = false;
            this.emit('statusChange', 'disconnected');
          },
        },
      });

      this.connected = true;
      this.emit('statusChange', 'connected');
    } catch (err: any) {
      console.error('[GeminiLiveProvider] Failed to connect to Gemini Live:', err);
      this.connected = false;
      this.emit('statusChange', 'error');
      throw err;
    }
  }

  /**
   * Connect to local/remote Mock Gemini Live WebSocket server
   */
  private async connectToMockServer(): Promise<void> {
    const endpoint = this.mockEndpoint || 'ws://127.0.0.1:8089';
    console.log(`[GeminiLiveProvider] Connecting to Mock Live WebSocket Server at ${endpoint}...`);

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(endpoint);
        this.wsClient = ws;

        ws.on('open', () => {
          console.log(`[GeminiLiveProvider] Connected to Mock Live Server at ${endpoint}`);
          this.connected = true;
          this.lastSentPrompt = null;

          // Send setup message
          const setupMsg = {
            setup: {
              model: this.model,
              systemInstruction: {
                parts: [{ text: this.config.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION }],
              },
              tools: [{ functionDeclarations: [NOTIFY_TOOL_DECLARATION] }],
              contextWindowCompression: {
                triggerTokens: '25000',
                slidingWindow: { targetTokens: 8000 },
              },
              sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
            },
          };
          ws.send(JSON.stringify(setupMsg));

          // Send initial prompt
          if (this.currentPrompt) {
            this.sendWakeCondition(this.currentPrompt);
          }

          this.emit('statusChange', 'connected');
          resolve();
        });

        ws.on('message', (data: any) => {
          try {
            const text = data.toString('utf-8');
            const message = JSON.parse(text);
            this.handleGeminiLiveMessage(message);
          } catch (err: any) {
            console.error('[GeminiLiveProvider] Failed to parse message from Mock Server:', err.message);
          }
        });

        ws.on('error', (err: Error) => {
          console.error('[GeminiLiveProvider] Mock Server WebSocket error:', err.message);
          this.emit('error', err);
          if (!this.connected) {
            reject(err);
          }
        });

        ws.on('close', (code: number, reason: Buffer) => {
          console.log(`[GeminiLiveProvider] Mock Server connection closed: ${code} ${reason.toString()}`);
          this.connected = false;
          this.emit('statusChange', 'disconnected');
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Central message dispatcher for Gemini Live messages
   */
  private handleGeminiLiveMessage(message: any): void {
    if (!message) return;

    // 1. Tool Calls (notify_user)
    if (message.toolCall?.functionCalls) {
      for (const fc of message.toolCall.functionCalls) {
        if (fc.name === 'notify_user') {
          const args = fc.args || {};
          const reason = args.reason || '满足提醒条件';
          const summary =
            args.summary || '检测到目标知识点讲解完毕，老师已进入下一环节。';
          const currentTopic = args.current_topic || '';

          console.log(`[GeminiLiveProvider] Triggering notify_user: reason="${reason}", summary="${summary}", topic="${currentTopic}"`);
          this.triggerNotification(reason, summary, currentTopic);

          // Acknowledge function call with silent scheduling
          this.sendToolCallResponse(fc.id, fc.name);
        }
      }
    }

    // 2. Session Resumption Update
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate?.newHandle) {
      this.resumeHandle = message.sessionResumptionUpdate.newHandle;
      console.log(`[GeminiLiveProvider] Received sessionResumption handle: ${this.resumeHandle}`);
    }

    // 3. GoAway signal (reconnect with resumption handle)
    if (message.goAway) {
      console.log('[GeminiLiveProvider] Received GoAway from server. Reconnecting with resumption handle...');
      this.reconnectWithHandle();
    }

    // 4. Usage Metadata
    if (message.usageMetadata) {
      const usage: TokenUsageMetadata = {
        promptTokenCount: message.usageMetadata.promptTokenCount || 0,
        responseTokenCount: message.usageMetadata.responseTokenCount || 0,
        totalTokenCount: message.usageMetadata.totalTokenCount || 0,
        promptTokensDetails: message.usageMetadata.promptTokensDetails || [],
        candidatesTokensDetails: message.usageMetadata.candidatesTokensDetails || [],
      };
      this.lastUsage = usage;
      this.emitUsageMetadata(usage);
    }
  }

  /**
   * Send SILENT response to function call
   */
  private sendToolCallResponse(callId: string, functionName: string): void {
    if (this.liveSession) {
      try {
        this.liveSession.sendToolResponse({
          functionResponses: [
            {
              id: callId,
              name: functionName,
              response: {
                result: 'notification_sent',
                scheduling: FunctionResponseScheduling.SILENT,
              },
            },
          ],
        });
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending tool response to Gemini Live:', err.message);
      }
    } else if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      try {
        this.wsClient.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: [
                {
                  id: callId,
                  name: functionName,
                  response: {
                    result: 'notification_sent',
                    scheduling: 'SILENT',
                  },
                },
              ],
            },
          })
        );
      } catch (err: any) {
        console.error('[GeminiLiveProvider] Error sending tool response to Mock Server:', err.message);
      }
    }
  }

  /**
   * Reconnect after GoAway using stored resumeHandle
   */
  private async reconnectWithHandle(): Promise<void> {
    if (this.isReconnecting) return;
    this.isReconnecting = true;

    try {
      await this.disconnect();
      await new Promise((r) => setTimeout(r, 1000));
      await this.connect();
      console.log('[GeminiLiveProvider] Session successfully resumed with handle');
    } catch (err) {
      console.error('[GeminiLiveProvider] Failed to resume session:', err);
    } finally {
      this.isReconnecting = false;
    }
  }
}

