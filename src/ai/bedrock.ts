import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

import { logger } from '../middleware/logger.js';
import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';
import type { CloudResponse } from './cloud-providers.js';

const REQUEST_TIMEOUT_MS = () => config.CLOUD_REQUEST_TIMEOUT_MS;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

let consecutiveBedrockFailures = 0;
let circuitOpenUntil = 0;
let bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region: config.BEDROCK_REGION });
  }
  return bedrockClient;
}

function buildUserMessage(userMessage: string, visionImages?: VisionImage[]): Message {
  if (visionImages && visionImages.length > 0) {
    throw new Error('Bedrock vision is not enabled in Garbanzo yet; use another provider for image prompts.');
  }

  const prompt = userMessage.trim() || 'Respond helpfully and concisely.';
  const content: ContentBlock[] = [{ text: prompt }];
  return { role: 'user', content };
}

function extractResponseText(content: ContentBlock[] | undefined): string {
  if (!content || content.length === 0) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block.text === 'string' && block.text.trim().length > 0) {
      parts.push(block.text);
    }
  }

  return parts.join('').trim();
}

export async function callBedrock(
  systemPrompt: string,
  userMessage: string,
  visionImages?: VisionImage[],
): Promise<CloudResponse> {
  if (!config.BEDROCK_MODEL_ID) {
    throw new Error('bedrock is not configured (missing BEDROCK_MODEL_ID)');
  }

  if (Date.now() < circuitOpenUntil) {
    const secondsRemaining = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
    throw new Error(`Bedrock circuit breaker open (${secondsRemaining}s remaining)`);
  }

  const controller = new AbortController();
  const timeoutMs = REQUEST_TIMEOUT_MS();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const client = getBedrockClient();
    const messages: Message[] = [buildUserMessage(userMessage, visionImages)];
    const system: SystemContentBlock[] = [{ text: systemPrompt }];

    logger.debug({
      provider: 'bedrock',
      model: config.BEDROCK_MODEL_ID,
      region: config.BEDROCK_REGION,
      maxTokens: config.BEDROCK_MAX_TOKENS,
      hasVision: !!visionImages?.length,
      imageCount: visionImages?.length ?? 0,
    }, 'Calling Bedrock provider');

    const command = new ConverseCommand({
      modelId: config.BEDROCK_MODEL_ID,
      system,
      messages,
      inferenceConfig: {
        maxTokens: config.BEDROCK_MAX_TOKENS,
      },
    });

    const response = await client.send(command, {
      abortSignal: controller.signal,
    });

    const text = extractResponseText(response.output?.message?.content);
    if (!text) {
      throw new Error('bedrock returned empty response');
    }

    consecutiveBedrockFailures = 0;
    circuitOpenUntil = 0;

    return {
      text,
      provider: 'bedrock',
      model: config.BEDROCK_MODEL_ID,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    consecutiveBedrockFailures += 1;

    if (consecutiveBedrockFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
      logger.warn({
        consecutiveBedrockFailures,
        cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
      }, 'Bedrock circuit breaker opened after repeated failures');
    }

    logger.warn({
      provider: 'bedrock',
      model: config.BEDROCK_MODEL_ID,
      region: config.BEDROCK_REGION,
      timeoutMs,
      err: error,
    }, 'Bedrock provider failed');

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
