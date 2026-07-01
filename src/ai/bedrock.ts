import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

import { config } from '../utils/config.js';
import type { VisionImage } from '../core/vision.js';
import { type CloudResponse } from './cloud-providers.js';
import { callCloudProvider } from './cloud-call.js';

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
  const modelId = config.BEDROCK_MODEL_ID;
  if (!modelId) {
    throw new Error('bedrock is not configured (missing BEDROCK_MODEL_ID)');
  }

  return callCloudProvider({
    provider: 'bedrock',
    model: modelId,
    perform: async (signal) => {
      const client = getBedrockClient();
      const messages: Message[] = [buildUserMessage(userMessage, visionImages)];
      const system: SystemContentBlock[] = [{ text: systemPrompt }];

      const command = new ConverseCommand({
        modelId,
        system,
        messages,
        inferenceConfig: {
          maxTokens: config.BEDROCK_MAX_TOKENS,
        },
      });

      const response = await client.send(command, { abortSignal: signal });
      return extractResponseText(response.output?.message?.content);
    },
  });
}
