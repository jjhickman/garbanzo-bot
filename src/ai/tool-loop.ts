import { config } from '../utils/config.js';
import { performJsonRequest, type ProviderRequest } from './cloud-providers.js';
import type { AiTool } from './tools.js';

const TOOL_RESULT_MAX_CHARS = 1500;

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface OpenAiToolCall {
  id: string;
  type?: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiResponsesFunctionCall {
  item: Record<string, unknown>;
  callId: string;
  name: string;
  arguments: string;
}

function cloneBody(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function messageList(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  return messages as Array<Record<string, unknown>>;
}

function inputList(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const input = body.input;
  if (!Array.isArray(input)) return [];
  return input as Array<Record<string, unknown>>;
}

function clampIterations(value: number): number {
  return Math.min(5, Math.max(1, Math.trunc(value)));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseAnthropicToolUses(data: unknown): AnthropicToolUse[] {
  const root = objectValue(data);
  if (!root || !Array.isArray(root.content)) return [];

  const toolUses: AnthropicToolUse[] = [];
  for (const block of root.content) {
    const obj = objectValue(block);
    if (!obj || obj.type !== 'tool_use') continue;
    if (typeof obj.id !== 'string' || typeof obj.name !== 'string') continue;
    toolUses.push({
      type: 'tool_use',
      id: obj.id,
      name: obj.name,
      input: objectValue(obj.input) ?? {},
    });
  }
  return toolUses;
}

function anthropicAssistantContent(data: unknown): unknown[] {
  const root = objectValue(data);
  return root && Array.isArray(root.content) ? root.content : [];
}

function parseOpenAiMessage(data: unknown): Record<string, unknown> | null {
  const root = objectValue(data);
  const choices = root?.choices;
  if (!Array.isArray(choices)) return null;
  const first = objectValue(choices[0]);
  return objectValue(first?.message);
}

function parseOpenAiToolCalls(data: unknown): OpenAiToolCall[] {
  const message = parseOpenAiMessage(data);
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];

  const toolCalls: OpenAiToolCall[] = [];
  for (const call of calls) {
    const obj = objectValue(call);
    const fn = objectValue(obj?.function);
    if (!obj || !fn) continue;
    if (typeof obj.id !== 'string' || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') continue;
    toolCalls.push({
      id: obj.id,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      function: {
        name: fn.name,
        arguments: fn.arguments,
      },
    });
  }
  return toolCalls;
}

function parseOpenAiResponsesFunctionCalls(data: unknown): OpenAiResponsesFunctionCall[] {
  const root = objectValue(data);
  const output = root?.output;
  if (!Array.isArray(output)) return [];

  const calls: OpenAiResponsesFunctionCall[] = [];
  for (const item of output) {
    const obj = objectValue(item);
    if (!obj || obj.type !== 'function_call') continue;
    if (typeof obj.call_id !== 'string' || typeof obj.name !== 'string' || typeof obj.arguments !== 'string') continue;
    calls.push({
      item: cloneBody(obj),
      callId: obj.call_id,
      name: obj.name,
      arguments: obj.arguments,
    });
  }
  return calls;
}

function parseFunctionArguments(value: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function truncateToolResult(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS - 3)}...`;
}

async function executeTool(name: string, input: Record<string, unknown>, tools: AiTool[]): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return `Tool ${name} is not available.`;

  try {
    return truncateToolResult(await tool.execute(input));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return truncateToolResult(`Tool ${name} failed: ${message}`);
  }
}

function requestWithBody(req: ProviderRequest, body: Record<string, unknown>): ProviderRequest {
  return { ...req, body };
}

export async function runAnthropicToolLoop(
  req: ProviderRequest,
  tools: AiTool[],
  signal: AbortSignal,
  maxIterations: number = config.AI_TOOL_MAX_ITERATIONS,
): Promise<string> {
  const body = cloneBody(req.body);
  const messages = messageList(body);
  const iterations = clampIterations(maxIterations);

  for (let i = 0; i < iterations; i += 1) {
    const data = await performJsonRequest(requestWithBody(req, body), signal);
    const toolUses = parseAnthropicToolUses(data);
    if (toolUses.length === 0) return req.parser(data);

    messages.push({ role: 'assistant', content: anthropicAssistantContent(data) });

    const results = [];
    for (const toolUse of toolUses) {
      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: await executeTool(toolUse.name, toolUse.input, tools),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  body.tool_choice = { type: 'none' };
  const data = await performJsonRequest(requestWithBody(req, body), signal);
  return req.parser(data);
}

export async function runOpenAiCompatToolLoop(
  req: ProviderRequest,
  tools: AiTool[],
  signal: AbortSignal,
  maxIterations: number = config.AI_TOOL_MAX_ITERATIONS,
): Promise<string> {
  const body = cloneBody(req.body);
  const messages = messageList(body);
  const iterations = clampIterations(maxIterations);

  for (let i = 0; i < iterations; i += 1) {
    const data = await performJsonRequest(requestWithBody(req, body), signal);
    const toolCalls = parseOpenAiToolCalls(data);
    if (toolCalls.length === 0) return req.parser(data);

    const assistantMessage = parseOpenAiMessage(data);
    if (assistantMessage) messages.push({ role: 'assistant', ...assistantMessage });

    for (const toolCall of toolCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: await executeTool(
          toolCall.function.name,
          parseFunctionArguments(toolCall.function.arguments),
          tools,
        ),
      });
    }
  }

  body.tool_choice = 'none';
  const data = await performJsonRequest(requestWithBody(req, body), signal);
  return req.parser(data);
}

export async function runOpenAiResponsesToolLoop(
  req: ProviderRequest,
  tools: AiTool[],
  signal: AbortSignal,
  maxIterations: number = config.AI_TOOL_MAX_ITERATIONS,
): Promise<string> {
  const body = cloneBody(req.body);
  const input = inputList(body);
  const iterations = clampIterations(maxIterations);

  for (let i = 0; i < iterations; i += 1) {
    const data = await performJsonRequest(requestWithBody(req, body), signal);
    const functionCalls = parseOpenAiResponsesFunctionCalls(data);
    if (functionCalls.length === 0) return req.parser(data);

    for (const call of functionCalls) {
      input.push(call.item);
      input.push({
        type: 'function_call_output',
        call_id: call.callId,
        output: await executeTool(call.name, parseFunctionArguments(call.arguments), tools),
      });
    }
  }

  body.tool_choice = 'none';
  const data = await performJsonRequest(requestWithBody(req, body), signal);
  return req.parser(data);
}
