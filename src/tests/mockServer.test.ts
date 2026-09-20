import { GeminiLiveMockServer } from '../mock/geminiLiveMockServer';
import { WebSocket } from 'ws';
import { GeminiLiveProvider, toBuffer, toBase64 } from '../core/provider/geminiLiveProvider';

async function runMockServerTest() {
  console.log('=== [TEST] Starting GeminiLiveMockServer Test ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${msg}`);
      failed++;
    }
  }

  // Test 0: Binary and Base64 helper robustness
  console.log('[Test 0] Testing toBuffer & toBase64 helper robustness...');
  const testBytes = new Uint8Array([23, 255, 40, 255, 182, 255, 101, 0, 196, 0, 14]);
  const expectedBase64 = Buffer.from(testBytes).toString('base64');
  
  const fromUint8 = toBase64(testBytes);
  assert(fromUint8 === expectedBase64, `Uint8Array correctly converts to Base64 (got ${fromUint8})`);

  const fromArrayBuffer = toBase64(testBytes.buffer);
  assert(fromArrayBuffer === expectedBase64, `ArrayBuffer correctly converts to Base64 (got ${fromArrayBuffer})`);

  const commaSeparated = '23,255,40,255,182,255,101,0,196,0,14';
  const fromCommaString = toBase64(commaSeparated);
  assert(fromCommaString === expectedBase64, `Comma-separated string recovery converts to Base64 (got ${fromCommaString})`);

  const buf = toBuffer(testBytes);
  assert(Buffer.isBuffer(buf) && buf.length === testBytes.length, 'toBuffer returns valid Buffer instance');

  // Test 0.5: GeminiLiveProvider backend switching (AI Studio <-> Vertex AI <-> Mock)
  console.log('[Test 0.5] Testing GeminiLiveProvider backend switching (AI Studio vs Vertex AI)...');
  const liveProvider = new GeminiLiveProvider({
    apiKey: 'test-api-key',
    model: 'gemini-3.8-live',
    backendType: 'aistudio',
  });
  assert(liveProvider.getBackendType() === 'aistudio', 'Provider initializes with aistudio backend');
  assert(liveProvider.isUsingMockServer() === false, 'isUsingMockServer is false for aistudio');

  // Switch to Vertex AI
  liveProvider.setProviderConfig({
    backendType: 'vertex',
    project: 'gcp-my-project-123',
    location: 'us-central1',
  });
  assert(liveProvider.getBackendType() === 'vertex', 'Provider switches to vertex backend');
  const vertexCfg = liveProvider.getVertexConfig();
  assert(vertexCfg.project === 'gcp-my-project-123', 'Vertex project configured correctly');
  assert(vertexCfg.location === 'us-central1', 'Vertex location configured correctly');
  assert(liveProvider.isUsingMockServer() === false, 'isUsingMockServer is false for vertex');

  // Switch to Mock
  liveProvider.setBackendType('mock');
  assert(liveProvider.getBackendType() === 'mock', 'Provider switches to mock backend');
  assert(liveProvider.isUsingMockServer() === true, 'isUsingMockServer is true for mock');

  const info = liveProvider.getProviderInfo();
  assert(info.backendType === 'mock', 'getProviderInfo returns accurate backendType');
  assert(info.vertexProject === 'gcp-my-project-123', 'getProviderInfo returns saved vertexProject');

  const server = new GeminiLiveMockServer({
    port: 0,
    proactiveIntervalMs: 500, // Speed up interval for fast testing
    usageIntervalMs: 600,
    logLevel: 'error', // Keep test output clean
  });

  try {
    // 1. Test Server Start
    const port = await server.start();
    assert(port > 0, `Server started on dynamically allocated port: ${port}`);
    assert(server.getPort() === port, `server.getPort() returns ${port}`);

    // 2. Test Client Connection & Setup
    const client = new WebSocket(`ws://localhost:${port}`);

    let setupCompleteReceived = false;
    let sessionResumptionReceived = false;
    let toolCallReceived: any = null;
    let usageMetadataReceived: any = null;

    await new Promise<void>((resolve, reject) => {
      client.on('open', () => {
        assert(true, 'Client connected to WebSocket server');
        resolve();
      });
      client.on('error', reject);
    });

    client.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.setupComplete) {
        setupCompleteReceived = true;
      }
      if (msg.sessionResumptionUpdate) {
        sessionResumptionReceived = true;
        assert(msg.sessionResumptionUpdate.resumable === true, 'sessionResumptionUpdate.resumable is true');
        assert(
          typeof msg.sessionResumptionUpdate.newHandle === 'string',
          'sessionResumptionUpdate.newHandle is a string'
        );
      }
      if (msg.toolCall) {
        toolCallReceived = msg.toolCall;
      }
      if (msg.usageMetadata) {
        usageMetadataReceived = msg.usageMetadata;
      }
    });

    // 3. Send setup message
    client.send(
      JSON.stringify({
        setup: {
          model: 'models/gemini-3.1-flash-live-preview',
          generationConfig: {
            responseModalities: ['AUDIO'],
          },
          systemInstruction: {
            parts: [{ text: 'You are a classroom assistant.' }],
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'notify_user',
                  description: 'Notify user when condition met',
                  parameters: {
                    type: 'object',
                    properties: {
                      reason: { type: 'string' },
                      summary: { type: 'string' },
                      current_topic: { type: 'string' },
                    },
                    required: ['reason', 'summary'],
                  },
                },
              ],
            },
          ],
          contextWindowCompression: {
            slidingWindow: { targetTokens: 8000 },
          },
          sessionResumption: {},
        },
      })
    );

    // Wait for setupComplete & sessionResumptionUpdate
    await new Promise((r) => setTimeout(r, 200));
    assert(setupCompleteReceived, 'Client received setupComplete message');
    assert(sessionResumptionReceived, 'Client received sessionResumptionUpdate message');

    // 4. Test Realtime Input (Audio, Video, Text)
    const dummyAudioBase64 = Buffer.alloc(3200).toString('base64');
    const dummyVideoBase64 = Buffer.alloc(16000).toString('base64');

    client.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: dummyAudioBase64,
          },
        },
      })
    );

    client.send(
      JSON.stringify({
        realtimeInput: {
          video: {
            mimeType: 'image/jpeg',
            data: dummyVideoBase64,
          },
        },
      })
    );

    client.send(
      JSON.stringify({
        realtimeInput: {
          text: '当前讲到哪一页了？',
        },
      })
    );

    // 5. Test clientContent (wake condition update)
    client.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: '老师讲完这道证明题叫我' }],
            },
          ],
          turnComplete: true,
        },
      })
    );

    // 6. Wait for Proactive ToolCall
    await new Promise((r) => setTimeout(r, 600));
    assert(toolCallReceived !== null, 'Client received proactive toolCall');
    assert(
      toolCallReceived?.functionCalls?.[0]?.name === 'notify_user',
      'Function call name is notify_user'
    );
    assert(
      typeof toolCallReceived?.functionCalls?.[0]?.args?.reason === 'string',
      'Function call has reason argument'
    );

    // 7. Send toolResponse
    const callId = toolCallReceived?.functionCalls?.[0]?.id || 'call_mock_1';
    client.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [
            {
              id: callId,
              name: 'notify_user',
              response: { output: { success: true } },
            },
          ],
        },
      })
    );

    // 8. Wait for usageMetadata
    await new Promise((r) => setTimeout(r, 300));
    assert(usageMetadataReceived !== null, 'Client received usageMetadata');
    assert(
      typeof usageMetadataReceived?.totalTokenCount === 'number',
      'usageMetadata contains totalTokenCount'
    );

    // 9. Verify Server Stats
    const stats = server.getStats();
    assert(stats.connectionsTotal === 1, `Stats connectionsTotal is 1 (got ${stats.connectionsTotal})`);
    assert(stats.connectionsActive === 1, `Stats connectionsActive is 1 (got ${stats.connectionsActive})`);
    assert(stats.audioChunksReceived === 1, `Stats audioChunksReceived is 1 (got ${stats.audioChunksReceived})`);
    assert(stats.videoFramesReceived === 1, `Stats videoFramesReceived is 1 (got ${stats.videoFramesReceived})`);
    assert(stats.textMessagesReceived === 1, `Stats textMessagesReceived is 1 (got ${stats.textMessagesReceived})`);
    assert(
      stats.clientContentMessagesReceived === 1,
      `Stats clientContentMessagesReceived is 1 (got ${stats.clientContentMessagesReceived})`
    );
    assert(
      stats.lastClientPrompt === '老师讲完这道证明题叫我',
      `Stats lastClientPrompt is recorded correctly: "${stats.lastClientPrompt}"`
    );
    assert(
      stats.toolResponsesReceived === 1,
      `Stats toolResponsesReceived is 1 (got ${stats.toolResponsesReceived})`
    );
    assert(stats.toolCallsSent >= 1, `Stats toolCallsSent is >= 1 (got ${stats.toolCallsSent})`);

    // 10. Clean up & Stop Server
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    await server.stop();
    assert(server.getPort() === 0, 'Server port resets to 0 after stop()');

    console.log('\n=== [TEST SUMMARY] ===');
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('Test threw unexpected error:', err);
    await server.stop();
    process.exit(1);
  }
}

if (require.main === module) {
  runMockServerTest();
}
