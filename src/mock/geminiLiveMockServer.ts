import { WebSocket, WebSocketServer, RawData } from 'ws';
import { IncomingMessage } from 'http';

export interface FunctionCallItem {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface FunctionResponseItem {
  id: string;
  name: string;
  response: Record<string, any>;
}

export interface SetupConfig {
  model?: string;
  generationConfig?: {
    responseModalities?: string[];
    speechConfig?: any;
    temperature?: number;
    topP?: number;
    [key: string]: any;
  };
  systemInstruction?: {
    parts?: Array<{ text?: string; [key: string]: any }>;
    [key: string]: any;
  };
  tools?: Array<{
    functionDeclarations?: Array<{
      name: string;
      description?: string;
      parameters?: any;
    }>;
    [key: string]: any;
  }>;
  contextWindowCompression?: {
    slidingWindow?: {
      targetTokens?: number;
    };
    [key: string]: any;
  };
  sessionResumption?: {
    handle?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  proactiveIntervalMs?: number; // default: 10000 ms (10s)
  usageIntervalMs?: number; // default: 10000 ms (10s)
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface MockServerStats {
  connectionsTotal: number;
  connectionsActive: number;
  audioChunksReceived: number;
  audioBytesReceived: number;
  videoFramesReceived: number;
  videoBytesReceived: number;
  textMessagesReceived: number;
  clientContentMessagesReceived: number;
  toolResponsesReceived: number;
  toolCallsSent: number;
  lastClientPrompt?: string;
  lastSetupConfig?: SetupConfig;
}

interface ClientSession {
  id: string;
  ws: WebSocket;
  connectedAt: number;
  setupConfig?: SetupConfig;
  proactiveTimer: NodeJS.Timeout | null;
  usageTimer: NodeJS.Timeout | null;
  audioChunks: number;
  audioBytes: number;
  videoFrames: number;
  videoBytes: number;
  textMessages: number;
  promptTokens: number;
  responseTokens: number;
  audioTokens: number;
  imageTokens: number;
  textTokens: number;
}

/**
 * GeminiLiveMockServer
 *
 * Implements a mock Gemini Live Bidi WebSocket server conforming to the
 * Google Gemini Multimodal Live API protocol.
 */
export class GeminiLiveMockServer {
  private wss: WebSocketServer | null = null;
  private port: number = 0;
  private options: MockServerOptions;
  private clients: Map<string, ClientSession> = new Map();
  private stats: MockServerStats = {
    connectionsTotal: 0,
    connectionsActive: 0,
    audioChunksReceived: 0,
    audioBytesReceived: 0,
    videoFramesReceived: 0,
    videoBytesReceived: 0,
    textMessagesReceived: 0,
    clientContentMessagesReceived: 0,
    toolResponsesReceived: 0,
    toolCallsSent: 0,
  };

  constructor(options: MockServerOptions = {}) {
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? '0.0.0.0',
      proactiveIntervalMs: options.proactiveIntervalMs ?? 10000,
      usageIntervalMs: options.usageIntervalMs ?? 10000,
      logLevel: options.logLevel ?? 'info',
    };
  }

  /**
   * Start the mock Gemini Live WebSocket server.
   * @param port Optional port override. If 0 or omitted, binds to available port or configured port.
   * @returns Listening port number.
   */
  public async start(port?: number): Promise<number> {
    if (this.wss) {
      return this.port;
    }

    const listenPort = port !== undefined ? port : (this.options.port || 0);

    return new Promise((resolve, reject) => {
      try {
        const wss = new WebSocketServer(
          {
            port: listenPort,
            host: this.options.host,
          },
          () => {
            const address = wss.address();
            if (address && typeof address === 'object') {
              this.port = address.port;
            } else {
              this.port = listenPort;
            }
            this.wss = wss;
            this.log('info', `GeminiLiveMockServer listening on ws://${this.options.host}:${this.port}`);
            resolve(this.port);
          }
        );

        wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
          this.handleConnection(ws, req);
        });

        wss.on('error', (err: Error) => {
          this.log('error', `WebSocket server error: ${err.message}`);
          if (!this.wss) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the mock server and disconnect all active clients.
   */
  public async stop(): Promise<void> {
    if (!this.wss) {
      return;
    }

    this.log('info', 'Stopping GeminiLiveMockServer...');

    // Clean up all client sessions
    for (const [clientId, session] of this.clients.entries()) {
      this.clearSessionTimers(session);
      try {
        session.ws.close(1000, 'Server shutting down');
      } catch {
        // Ignore close errors during shutdown
      }
    }
    this.clients.clear();
    this.stats.connectionsActive = 0;

    return new Promise((resolve, reject) => {
      this.wss?.close((err) => {
        this.wss = null;
        this.port = 0;
        if (err) {
          this.log('error', `Error while closing WebSocket server: ${err.message}`);
          reject(err);
        } else {
          this.log('info', 'GeminiLiveMockServer stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Get the current port the server is listening on.
   */
  public getPort(): number {
    return this.port;
  }

  /**
   * Get server statistics.
   */
  public getStats(): MockServerStats {
    return { ...this.stats };
  }

  /**
   * Set proactive message trigger interval.
   */
  public setProactiveInterval(intervalMs: number): void {
    this.options.proactiveIntervalMs = intervalMs;
    // Update existing sessions
    for (const session of this.clients.values()) {
      if (session.proactiveTimer) {
        clearInterval(session.proactiveTimer);
        session.proactiveTimer = setInterval(() => {
          this.sendProactiveToolCall(session);
        }, intervalMs);
      }
    }
  }

  /**
   * Manually trigger a proactive tool call to a specific client or all active clients.
   */
  public triggerToolCall(
    targetWs?: WebSocket,
    customArgs?: {
      reason?: string;
      summary?: string;
      current_topic?: string;
    }
  ): void {
    if (targetWs) {
      for (const session of this.clients.values()) {
        if (session.ws === targetWs) {
          this.sendProactiveToolCall(session, customArgs);
          return;
        }
      }
    } else {
      for (const session of this.clients.values()) {
        this.sendProactiveToolCall(session, customArgs);
      }
    }
  }

  /**
   * Send usage metadata to a specific client or all active clients.
   */
  public sendUsage(
    targetWs?: WebSocket,
    customUsage?: {
      promptTokenCount?: number;
      responseTokenCount?: number;
      totalTokenCount?: number;
      promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
    }
  ): void {
    if (targetWs) {
      for (const session of this.clients.values()) {
        if (session.ws === targetWs) {
          this.sendUsageMetadata(session, customUsage);
          return;
        }
      }
    } else {
      for (const session of this.clients.values()) {
        this.sendUsageMetadata(session, customUsage);
      }
    }
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const clientIp = req.socket.remoteAddress || 'unknown';

    this.stats.connectionsTotal++;
    this.stats.connectionsActive++;

    const session: ClientSession = {
      id: clientId,
      ws,
      connectedAt: Date.now(),
      proactiveTimer: null,
      usageTimer: null,
      audioChunks: 0,
      audioBytes: 0,
      videoFrames: 0,
      videoBytes: 0,
      textMessages: 0,
      promptTokens: 150,
      responseTokens: 35,
      audioTokens: 100,
      imageTokens: 40,
      textTokens: 10,
    };

    this.clients.set(clientId, session);
    this.log('info', `Client connected [${clientId}] from ${clientIp}. Total active: ${this.stats.connectionsActive}`);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.handleClientMessage(session, data, isBinary);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearSessionTimers(session);
      this.clients.delete(clientId);
      this.stats.connectionsActive = Math.max(0, this.stats.connectionsActive - 1);
      this.log(
        'info',
        `Client disconnected [${clientId}], code: ${code}, reason: ${reason.toString()}. Active: ${this.stats.connectionsActive}`
      );
    });

    ws.on('error', (err: Error) => {
      this.log('error', `Client error [${clientId}]: ${err.message}`);
    });
  }

  private handleClientMessage(session: ClientSession, rawData: RawData, isBinary: boolean): void {
    if (isBinary) {
      // Direct binary payload fallback
      const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData as any);
      session.audioBytes += buf.length;
      session.audioChunks++;
      this.stats.audioBytesReceived += buf.length;
      this.stats.audioChunksReceived++;
      this.log('debug', `[${session.id}] Received raw binary audio chunk: ${buf.length} bytes`);
      return;
    }

    let message: any;
    try {
      const text = rawData.toString('utf-8');
      message = JSON.parse(text);
    } catch (err: any) {
      this.log('warn', `[${session.id}] Failed to parse JSON message: ${err.message}`);
      return;
    }

    // 1. Handle "setup" message
    if (message.setup) {
      this.handleSetupMessage(session, message.setup);
      return;
    }

    // 2. Handle "realtimeInput" message (audio, video, text)
    if (message.realtimeInput) {
      this.handleRealtimeInput(session, message.realtimeInput);
      return;
    }

    // 3. Handle "clientContent" message (user turn, text, wake prompt updates)
    if (message.clientContent) {
      this.handleClientContent(session, message.clientContent);
      return;
    }

    // 4. Handle "toolResponse" message (function execution responses)
    if (message.toolResponse) {
      this.handleToolResponse(session, message.toolResponse);
      return;
    }

    this.log('debug', `[${session.id}] Received unknown or unhandled message type: ${Object.keys(message).join(', ')}`);
  }

  private handleSetupMessage(session: ClientSession, setup: SetupConfig): void {
    session.setupConfig = setup;
    this.stats.lastSetupConfig = setup;

    this.log('info', `[${session.id}] Received setup config:`);
    this.log('info', `  - Model: ${setup.model || 'unspecified'}`);
    if (setup.systemInstruction?.parts) {
      const siText = setup.systemInstruction.parts.map((p) => p.text).filter(Boolean).join(' ');
      this.log('info', `  - SystemInstruction: ${siText.slice(0, 100)}${siText.length > 100 ? '...' : ''}`);
    }
    if (setup.tools && setup.tools.length > 0) {
      const toolNames = setup.tools.flatMap((t) => t.functionDeclarations?.map((f) => f.name) || []);
      this.log('info', `  - Tools: [${toolNames.join(', ')}]`);
    }
    if (setup.contextWindowCompression) {
      this.log(
        'info',
        `  - ContextWindowCompression: targetTokens=${setup.contextWindowCompression.slidingWindow?.targetTokens}`
      );
    }
    if (setup.sessionResumption) {
      this.log('info', `  - SessionResumption: handle=${setup.sessionResumption.handle || 'new'}`);
    }

    // Acknowledge setup with setupComplete
    this.sendJson(session.ws, {
      setupComplete: {},
    });

    // Send initial sessionResumptionUpdate
    const initialHandle = `handle_initial_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.sendJson(session.ws, {
      sessionResumptionUpdate: {
        resumable: true,
        newHandle: initialHandle,
      },
    });

    // Start proactive tool call timer
    if (this.options.proactiveIntervalMs && this.options.proactiveIntervalMs > 0) {
      if (session.proactiveTimer) clearInterval(session.proactiveTimer);
      session.proactiveTimer = setInterval(() => {
        this.sendProactiveToolCall(session);
      }, this.options.proactiveIntervalMs);
    }

    // Start periodic usage metadata timer
    if (this.options.usageIntervalMs && this.options.usageIntervalMs > 0) {
      if (session.usageTimer) clearInterval(session.usageTimer);
      session.usageTimer = setInterval(() => {
        this.sendUsageMetadata(session);
      }, this.options.usageIntervalMs);
    }
  }

  private handleRealtimeInput(session: ClientSession, input: any): void {
    // 1. Audio stream
    if (input.audio) {
      const dataStr = input.audio.data || '';
      const byteLen = Math.floor((dataStr.length * 3) / 4);
      session.audioChunks++;
      session.audioBytes += byteLen;
      session.audioTokens += Math.max(1, Math.floor(byteLen / 320));
      session.promptTokens = session.audioTokens + session.imageTokens + session.textTokens;
      this.stats.audioChunksReceived++;
      this.stats.audioBytesReceived += byteLen;
      this.log('debug', `[${session.id}] Received audio chunk #${session.audioChunks} (${byteLen} bytes, ${input.audio.mimeType || 'pcm'})`);
    }

    // 2. Video frame
    if (input.video) {
      const dataStr = input.video.data || '';
      const byteLen = Math.floor((dataStr.length * 3) / 4);
      session.videoFrames++;
      session.videoBytes += byteLen;
      session.imageTokens += 40;
      session.promptTokens = session.audioTokens + session.imageTokens + session.textTokens;
      this.stats.videoFramesReceived++;
      this.stats.videoBytesReceived += byteLen;
      this.log('debug', `[${session.id}] Received video frame #${session.videoFrames} (${byteLen} bytes, ${input.video.mimeType || 'image/jpeg'})`);
    }

    // 3. Text
    if (input.text) {
      session.textMessages++;
      session.textTokens += Math.max(1, Math.ceil(input.text.length / 4));
      session.promptTokens = session.audioTokens + session.imageTokens + session.textTokens;
      this.stats.textMessagesReceived++;
      this.stats.lastClientPrompt = input.text;
      this.log('info', `[${session.id}] Received realtime text: "${input.text}"`);
    }

    // 4. Legacy mediaChunks
    if (Array.isArray(input.mediaChunks)) {
      for (const chunk of input.mediaChunks) {
        const mimeType = chunk.mimeType || '';
        const dataStr = chunk.data || '';
        const byteLen = Math.floor((dataStr.length * 3) / 4);
        if (mimeType.startsWith('audio/')) {
          session.audioChunks++;
          session.audioBytes += byteLen;
          session.audioTokens += Math.max(1, Math.floor(byteLen / 320));
          this.stats.audioChunksReceived++;
          this.stats.audioBytesReceived += byteLen;
        } else if (mimeType.startsWith('image/')) {
          session.videoFrames++;
          session.videoBytes += byteLen;
          session.imageTokens += 40;
          this.stats.videoFramesReceived++;
          this.stats.videoBytesReceived += byteLen;
        }
      }
      session.promptTokens = session.audioTokens + session.imageTokens + session.textTokens;
    }
  }

  private handleClientContent(session: ClientSession, content: any): void {
    this.stats.clientContentMessagesReceived++;
    let extractedText = '';

    if (Array.isArray(content.turns)) {
      for (const turn of content.turns) {
        if (Array.isArray(turn.parts)) {
          for (const part of turn.parts) {
            if (part.text) {
              extractedText += (extractedText ? ' ' : '') + part.text;
            }
          }
        }
      }
    }

    if (extractedText) {
      this.stats.lastClientPrompt = extractedText;
      session.textTokens += Math.max(1, Math.ceil(extractedText.length / 4));
      session.promptTokens = session.audioTokens + session.imageTokens + session.textTokens;
      this.log('info', `[${session.id}] Received clientContent wake prompt update: "${extractedText}"`);
    } else {
      this.log('info', `[${session.id}] Received clientContent message: turnComplete=${content.turnComplete}`);
    }
  }

  private handleToolResponse(session: ClientSession, toolResponse: any): void {
    this.stats.toolResponsesReceived++;
    const responses: FunctionResponseItem[] = toolResponse.functionResponses || [];
    this.log('info', `[${session.id}] Received toolResponse for ${responses.length} function call(s):`);
    for (const res of responses) {
      this.log('info', `  - ID: ${res.id}, Name: ${res.name}, Output: ${JSON.stringify(res.response)}`);
    }
  }

  private sendProactiveToolCall(
    session: ClientSession,
    customArgs?: {
      reason?: string;
      summary?: string;
      current_topic?: string;
    }
  ): void {
    if (session.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const callId = `call_mock_${Date.now()}`;
    const defaultArgs = {
      reason: '目标知识点/证明讲解完毕',
      summary: '【Mock Live 观察】检测到老师已完成当前证明推导，黑板内容已翻页并进入下一节。',
      current_topic: '下一节核心知识点',
    };

    const args = { ...defaultArgs, ...customArgs };

    const toolCallMessage = {
      toolCall: {
        functionCalls: [
          {
            id: callId,
            name: 'notify_user',
            args,
          },
        ],
      },
    };

    this.stats.toolCallsSent++;
    session.responseTokens += 35;
    this.log('info', `[${session.id}] Sending proactive toolCall notify_user (ID: ${callId}): "${args.reason}"`);
    this.sendJson(session.ws, toolCallMessage);
  }

  private sendUsageMetadata(
    session: ClientSession,
    customUsage?: {
      promptTokenCount?: number;
      responseTokenCount?: number;
      totalTokenCount?: number;
      promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
    }
  ): void {
    if (session.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const promptTokens = customUsage?.promptTokenCount ?? session.promptTokens;
    const responseTokens = customUsage?.responseTokenCount ?? session.responseTokens;
    const totalTokens = customUsage?.totalTokenCount ?? promptTokens + responseTokens;

    const usageMessage = {
      usageMetadata: {
        promptTokenCount: promptTokens,
        responseTokenCount: responseTokens,
        totalTokenCount: totalTokens,
        promptTokensDetails: customUsage?.promptTokensDetails ?? [
          { modality: 'AUDIO', tokenCount: session.audioTokens },
          { modality: 'IMAGE', tokenCount: session.imageTokens },
          { modality: 'TEXT', tokenCount: session.textTokens },
        ],
      },
    };

    this.log('debug', `[${session.id}] Sending usageMetadata: total=${totalTokens} (prompt=${promptTokens}, resp=${responseTokens})`);
    this.sendJson(session.ws, usageMessage);
  }

  private sendJson(ws: WebSocket, data: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private clearSessionTimers(session: ClientSession): void {
    if (session.proactiveTimer) {
      clearInterval(session.proactiveTimer);
      session.proactiveTimer = null;
    }
    if (session.usageTimer) {
      clearInterval(session.usageTimer);
      session.usageTimer = null;
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const configuredLevel = this.options.logLevel || 'info';
    if (levels[level] >= levels[configuredLevel]) {
      const timestamp = new Date().toISOString().substring(11, 19);
      console.log(`[${timestamp}] [GeminiLiveMockServer] [${level.toUpperCase()}] ${message}`);
    }
  }
}

// Support direct execution via CLI
if (require.main === module) {
  const port = parseInt(process.env.MOCK_LIVE_PORT || '8089', 10);
  const server = new GeminiLiveMockServer({
    port,
    logLevel: 'info',
    proactiveIntervalMs: 10000,
    usageIntervalMs: 10000,
  });

  server
    .start()
    .then((actualPort) => {
      console.log(`\n======================================================`);
      console.log(` Gemini Live Mock API WebSocket Server`);
      console.log(` Status: Running`);
      console.log(` Port: ${actualPort}`);
      console.log(` URL: ws://localhost:${actualPort}`);
      console.log(` Proactive notify_user toolCall interval: 10s`);
      console.log(`======================================================\n`);
      console.log('Press Ctrl+C to terminate the mock server.\n');
    })
    .catch((err) => {
      console.error('Failed to start GeminiLiveMockServer:', err);
      process.exit(1);
    });

  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT. Gracefully shutting down GeminiLiveMockServer...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM. Gracefully shutting down GeminiLiveMockServer...');
    await server.stop();
    process.exit(0);
  });
}
