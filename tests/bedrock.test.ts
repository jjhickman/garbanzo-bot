import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send = sendMock;
  }

  class ConverseCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    BedrockRuntimeClient,
    ConverseCommand,
  };
});

describe('Bedrock integration', () => {
  afterEach(() => {
    sendMock.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('throws a clear error when BEDROCK_MODEL_ID is missing', async () => {
    const { config } = await import('../src/utils/config.js');
    config.BEDROCK_MODEL_ID = '';

    const { callBedrock } = await import('../src/ai/bedrock.js');

    await expect(callBedrock('system', 'hello')).rejects.toThrow('missing BEDROCK_MODEL_ID');
  });

  it('sends a Converse request and parses text output', async () => {
    const { config } = await import('../src/utils/config.js');
    config.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';
    config.BEDROCK_REGION = 'us-east-1';
    config.BEDROCK_MAX_TOKENS = 512;

    sendMock.mockResolvedValue({
      output: {
        message: {
          content: [
            { text: 'Hello' },
            { text: ' from Bedrock' },
          ],
        },
      },
    });

    const { callBedrock } = await import('../src/ai/bedrock.js');
    const out = await callBedrock('system prompt', 'hello world');

    expect(out.provider).toBe('bedrock');
    expect(out.model).toBe('anthropic.claude-3-5-haiku-20241022-v1:0');
    expect(out.text).toBe('Hello from Bedrock');

    const firstCall = sendMock.mock.calls[0]?.[0] as { input?: { modelId?: string; inferenceConfig?: { maxTokens?: number } } } | undefined;
    expect(firstCall?.input?.modelId).toBe('anthropic.claude-3-5-haiku-20241022-v1:0');
    expect(firstCall?.input?.inferenceConfig?.maxTokens).toBe(512);
  });

  it('rejects vision prompts for now so router can fail over', async () => {
    const { config } = await import('../src/utils/config.js');
    config.BEDROCK_MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';

    const { callBedrock } = await import('../src/ai/bedrock.js');

    await expect(
      callBedrock('system', 'what is this?', [{ mediaType: 'image/png', base64: 'ZmFrZQ==' }]),
    ).rejects.toThrow('vision is not enabled');
  });
});
