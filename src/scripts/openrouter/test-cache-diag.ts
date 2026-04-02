import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { generateApiToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/providers/anthropic';

type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type TextMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type AssistantToolCallMessage = {
  role: 'assistant';
  content: string;
  tool_calls: ToolCall[];
};

type ToolMessage = {
  role: 'tool';
  tool_call_id: string;
  content: string;
};

type RequestMessage = TextMessage | AssistantToolCallMessage | ToolMessage;

type FixtureTemplate = {
  systemMessage: string;
  tools: ToolDefinition[];
};

type RequestPhase = 'user' | 'tool-followup';

type RequestResult = {
  requestNumber: number;
  turn: number;
  phase: RequestPhase;
  messageCount: number;
  lastRole: RequestMessage['role'];
  toolCalls: number;
  elapsedMs: number;
  responseText: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
};

type StreamStepResult = Omit<
  RequestResult,
  'requestNumber' | 'turn' | 'phase' | 'messageCount' | 'lastRole' | 'toolCalls'
> & {
  assistantMessage: TextMessage | AssistantToolCallMessage;
  toolCallsPayload: ToolCall[];
};

const WORKSPACE_ROOT = process.cwd();
const FIXTURE = loadFixtureTemplate();

const SYSTEM_MESSAGE: TextMessage = {
  role: 'system',
  content: FIXTURE.systemMessage,
};

const TOOL_DEFINITIONS = FIXTURE.tools;

const TURNS = [
  {
    role: 'user',
    content:
      'Use only read-only tools for this test. First call list_files on "src/lib/providers" and then read_file on "src/lib/providers/openrouter/request-helpers.ts" and "src/lib/providerHash.ts". After the tool results are returned, explain how cache breakpoints and prompt cache keys are applied. Do not use attempt_completion or ask_followup_question.',
  },
  {
    role: 'user',
    content:
      'Use search_files with regex "cache_write_tokens|cache_hit_tokens" under "src/lib" and then read_file on "src/lib/processUsage.ts". After the tool results are returned, explain how cache reads and writes are recorded. Do not use attempt_completion or ask_followup_question.',
  },
  {
    role: 'user',
    content:
      'Use search_files with regex "CacheDiag" under "src/lib" and then read_file on "src/lib/providers/cache-debug.ts". After the tool results are returned, describe which request fields are most important for diagnosing cache misses. Do not use attempt_completion or ask_followup_question.',
  },
] satisfies Array<{ role: 'user'; content: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolDefinition(value: unknown): value is ToolDefinition {
  if (!isRecord(value)) return false;
  if (value.type !== 'function') return false;
  if (!isRecord(value.function)) return false;
  return (
    typeof value.function.name === 'string' &&
    typeof value.function.description === 'string' &&
    isRecord(value.function.parameters)
  );
}

function loadFixtureTemplate(): FixtureTemplate {
  const fixturePath = path.resolve(WORKSPACE_ROOT, 'src/lib/utils/testdata/no_tool_request.json');
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));

  if (!isRecord(raw) || !Array.isArray(raw.messages) || !Array.isArray(raw.tools)) {
    throw new Error('Realistic request fixture is malformed');
  }

  const systemEntry = raw.messages.find(
    message => isRecord(message) && message.role === 'system' && typeof message.content === 'string'
  );

  if (!systemEntry || typeof systemEntry.content !== 'string') {
    throw new Error('Fixture is missing a string system message');
  }

  const tools = raw.tools.filter(isToolDefinition);
  if (tools.length === 0) {
    throw new Error('Fixture is missing tool definitions');
  }

  return {
    systemMessage: systemEntry.content,
    tools,
  };
}

async function authenticateUser(email: string) {
  const user = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(1);

  if (!user || user.length === 0) {
    throw new Error(`User with email "${email}" not found in the database`);
  }

  const authToken = generateApiToken(user[0]);
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
  return { authToken, baseUrl };
}

function buildProviderPreference(preferredProvider: string | undefined) {
  if (!preferredProvider) {
    return undefined;
  }

  const fallbackProvider = preferredProvider === 'anthropic' ? 'amazon-bedrock' : 'anthropic';
  return { order: [preferredProvider, fallbackProvider] };
}

function appendToolCallDelta(toolCalls: Map<number, ToolCall>, partialCall: unknown) {
  if (!isRecord(partialCall) || typeof partialCall.index !== 'number') {
    return;
  }

  const current: ToolCall = toolCalls.get(partialCall.index) ?? {
    id: `cache-diag-tool-${partialCall.index}`,
    type: 'function',
    function: {
      name: '',
      arguments: '',
    },
  };

  if (typeof partialCall.id === 'string' && partialCall.id.length > 0) {
    current.id = partialCall.id;
  }

  if (isRecord(partialCall.function)) {
    if (typeof partialCall.function.name === 'string') {
      current.function.name += partialCall.function.name;
    }
    if (typeof partialCall.function.arguments === 'string') {
      current.function.arguments += partialCall.function.arguments;
    }
  }

  toolCalls.set(partialCall.index, current);
}

async function streamStep(
  baseUrl: string,
  authToken: string,
  model: string,
  taskId: string,
  messages: RequestMessage[],
  preferredProvider?: string
): Promise<StreamStepResult> {
  const startTime = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages,
    tools: TOOL_DEFINITIONS,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 512,
  };

  const providerPreference = buildProviderPreference(preferredProvider);
  if (providerPreference) {
    body.provider = providerPreference;
  }

  const response = await fetch(`${baseUrl}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      'x-kilocode-taskid': taskId,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status} ${response.statusText}`;
    try {
      const errorBody = await response.json();
      errorDetail = errorBody.error?.message || errorBody.error || JSON.stringify(errorBody);
    } catch {
      // Keep the HTTP status message when the error body is not JSON.
    }
    throw new Error(`Request failed: ${errorDetail}`);
  }

  if (!response.body) {
    throw new Error('Response body is null — expected a stream');
  }

  const contentParts: string[] = [];
  const toolCalls = new Map<number, ToolCall>();
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedTokens: number | null = null;
  let cacheWriteTokens: number | null = null;

  await new Promise<void>((resolve, reject) => {
    const parser = createParser({
      onEvent(event: EventSourceMessage) {
        if (event.data === '[DONE]') {
          resolve();
          return;
        }

        try {
          const chunk = JSON.parse(event.data);
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
          const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : null;

          if (delta && typeof delta.content === 'string') {
            contentParts.push(delta.content);
          }

          if (delta && Array.isArray(delta.tool_calls)) {
            for (const partialCall of delta.tool_calls) {
              appendToolCallDelta(toolCalls, partialCall);
            }
          }

          if (isRecord(chunk.usage)) {
            promptTokens =
              typeof chunk.usage.prompt_tokens === 'number' ? chunk.usage.prompt_tokens : null;
            completionTokens =
              typeof chunk.usage.completion_tokens === 'number'
                ? chunk.usage.completion_tokens
                : null;

            const promptTokenDetails = isRecord(chunk.usage.prompt_tokens_details)
              ? chunk.usage.prompt_tokens_details
              : null;

            cachedTokens =
              promptTokenDetails && typeof promptTokenDetails.cached_tokens === 'number'
                ? promptTokenDetails.cached_tokens
                : null;

            cacheWriteTokens =
              promptTokenDetails && typeof promptTokenDetails.cache_write_tokens === 'number'
                ? promptTokenDetails.cache_write_tokens
                : null;
          }
        } catch {
          // Skip malformed chunks.
        }
      },
    });

    const bodyStream = response.body;
    if (!bodyStream) {
      reject(new Error('Response body unexpectedly missing during streaming'));
      return;
    }

    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();

    function pump(): void {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            resolve();
            return;
          }

          parser.feed(decoder.decode(value, { stream: true }));
          pump();
        })
        .catch(reject);
    }

    pump();
  });

  const elapsedMs = Date.now() - startTime;
  const responseText = contentParts.join('');
  const toolCallsPayload = Array.from(toolCalls.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, toolCall]) => toolCall);

  const assistantMessage: TextMessage | AssistantToolCallMessage =
    toolCallsPayload.length > 0
      ? {
          role: 'assistant',
          content: responseText,
          tool_calls: toolCallsPayload,
        }
      : {
          role: 'assistant',
          content: responseText,
        };

  return {
    elapsedMs,
    responseText,
    promptTokens,
    completionTokens,
    cachedTokens,
    cacheWriteTokens,
    assistantMessage,
    toolCallsPayload,
  };
}

function parseJsonObject(jsonText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(jsonText);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function numberLines(text: string, maxLines = 160): string {
  const allLines = text.split('\n');
  const visibleLines = allLines.slice(0, maxLines);
  const rendered = visibleLines.map((line, index) => `${index + 1}: ${line}`).join('\n');
  if (visibleLines.length === allLines.length) {
    return rendered;
  }
  return `${rendered}\n...truncated after ${maxLines} lines...`;
}

function resolveWorkspacePath(relativePath: string): string {
  return path.resolve(WORKSPACE_ROOT, relativePath);
}

function readFilesTool(args: Record<string, unknown>): string {
  if (!Array.isArray(args.files)) {
    return JSON.stringify({ error: 'read_file requires a files array' });
  }

  const outputs: string[] = [];
  for (const fileEntry of args.files.slice(0, 4)) {
    if (!isRecord(fileEntry) || typeof fileEntry.path !== 'string') {
      continue;
    }

    const requestedPath = fileEntry.path;
    try {
      const absolutePath = resolveWorkspacePath(requestedPath);
      const content = readFileSync(absolutePath, 'utf8');
      outputs.push(`FILE: ${requestedPath}\n${numberLines(content)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputs.push(`FILE: ${requestedPath}\nERROR: ${message}`);
    }
  }

  if (outputs.length === 0) {
    return JSON.stringify({ error: 'No readable files were provided' });
  }

  return outputs.join('\n\n');
}

function listFilesRecursive(rootPath: string, recursive: boolean): string[] {
  const entries: string[] = [];
  const maxEntries = 120;

  function walk(currentAbsolutePath: string, currentRelativePath: string) {
    const directoryEntries = readdirSync(currentAbsolutePath, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    );

    for (const directoryEntry of directoryEntries) {
      if (entries.length >= maxEntries) {
        return;
      }

      const nextRelativePath = currentRelativePath
        ? `${currentRelativePath}/${directoryEntry.name}`
        : directoryEntry.name;

      if (directoryEntry.isDirectory()) {
        entries.push(`${nextRelativePath}/`);
        if (recursive) {
          walk(path.join(currentAbsolutePath, directoryEntry.name), nextRelativePath);
        }
      } else {
        entries.push(nextRelativePath);
      }
    }
  }

  walk(rootPath, '');
  return entries;
}

function listFilesTool(args: Record<string, unknown>): string {
  const requestedPath = typeof args.path === 'string' ? args.path : '.';
  const recursive = typeof args.recursive === 'boolean' ? args.recursive : false;

  try {
    const absolutePath = resolveWorkspacePath(requestedPath);
    const stats = statSync(absolutePath);
    if (!stats.isDirectory()) {
      return JSON.stringify({ error: `${requestedPath} is not a directory` });
    }

    const entries = listFilesRecursive(absolutePath, recursive);
    if (entries.length === 0) {
      return `${requestedPath}: <empty>`;
    }

    return entries.join('\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: message });
  }
}

function searchFilesTool(args: Record<string, unknown>): string {
  const searchPath = typeof args.path === 'string' ? args.path : '.';
  const regex = typeof args.regex === 'string' ? args.regex : null;
  const filePattern = typeof args.file_pattern === 'string' ? args.file_pattern : '*';

  if (!regex) {
    return JSON.stringify({ error: 'search_files requires a regex string' });
  }

  try {
    const absolutePath = resolveWorkspacePath(searchPath);
    const output = execFileSync(
      'rg',
      ['-n', '-m', '20', '--glob', filePattern, regex, absolutePath],
      {
        cwd: WORKSPACE_ROOT,
        encoding: 'utf8',
      }
    );

    return output.trim() || 'No matches found';
  } catch (error) {
    if (isRecord(error) && typeof error.stdout === 'string' && error.stdout.trim()) {
      return error.stdout.trim();
    }
    return 'No matches found';
  }
}

function codebaseSearchTool(args: Record<string, unknown>): string {
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
  const likelyMatches = [
    'src/lib/providers/openrouter/request-helpers.ts',
    'src/lib/providerHash.ts',
    'src/lib/processUsage.ts',
    'src/lib/providers/cache-debug.ts',
    'src/app/api/openrouter/[...path]/route.ts',
  ].filter(filePath => filePath.toLowerCase().includes(query) || query.includes('cache'));

  if (likelyMatches.length === 0) {
    return JSON.stringify({ query, matches: ['src/lib/processUsage.ts'] });
  }

  return JSON.stringify({ query, matches: likelyMatches });
}

function fetchInstructionsTool(): string {
  return [
    'Use the provided read-only tool results to answer directly.',
    'Do not call ask_followup_question or attempt_completion in this cache diagnostic harness.',
    'Keep answers concise and grounded in the tool results already returned.',
  ].join('\n');
}

function withHarnessNote(output: string): string {
  return [
    output,
    '',
    'CACHE DIAGNOSTIC HARNESS: Prefer answering directly with the tool results already returned instead of calling more tools.',
  ].join('\n');
}

function executeToolCall(toolCall: ToolCall): string {
  const toolName = toolCall.function.name;
  const args = parseJsonObject(toolCall.function.arguments) ?? {};

  switch (toolName) {
    case 'read_file':
      return withHarnessNote(readFilesTool(args));
    case 'list_files':
      return withHarnessNote(listFilesTool(args));
    case 'search_files':
      return withHarnessNote(searchFilesTool(args));
    case 'codebase_search':
      return withHarnessNote(codebaseSearchTool(args));
    case 'fetch_instructions':
      return withHarnessNote(fetchInstructionsTool());
    case 'ask_followup_question':
      return withHarnessNote(
        'Follow-up questions are disabled in this cache diagnostic test. Continue with the existing context and answer directly after using read-only tools.'
      );
    case 'attempt_completion':
      return withHarnessNote(
        'attempt_completion is disabled in this cache diagnostic test. Provide the final answer in a normal assistant response instead.'
      );
    default:
      return withHarnessNote(
        JSON.stringify({
          ok: true,
          tool: toolName,
          note: 'Tool execution is stubbed in the cache diagnostic harness.',
          arguments: args,
        })
      );
  }
}

function executeToolCalls(toolCalls: ToolCall[]): ToolMessage[] {
  return toolCalls.map(toolCall => ({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: executeToolCall(toolCall),
  }));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function cacheHitRate(promptTokens: number | null, cachedTokens: number | null): string {
  if (promptTokens === null || cachedTokens === null || promptTokens === 0) return 'N/A';
  return `${Math.round((cachedTokens / promptTokens) * 100)}%`;
}

function printSummary(results: RequestResult[], label?: string) {
  console.log(`\n=== Summary${label ? ` (${label})` : ''} ===`);
  console.log(
    '| Req | Turn | Phase         | Msgs | Last | ToolCalls | Input | Output | Cache Write | Cache Read | Hit Rate |'
  );
  console.log(
    '|-----|------|---------------|------|------|-----------|-------|--------|-------------|------------|----------|'
  );

  for (const result of results) {
    const input = result.promptTokens !== null ? String(result.promptTokens).padEnd(5) : 'N/A  ';
    const output =
      result.completionTokens !== null ? String(result.completionTokens).padEnd(6) : 'N/A   ';
    const write =
      result.cacheWriteTokens !== null ? String(result.cacheWriteTokens).padEnd(11) : 'N/A        ';
    const read =
      result.cachedTokens !== null ? String(result.cachedTokens).padEnd(10) : 'N/A       ';
    const hitRate = cacheHitRate(result.promptTokens, result.cachedTokens).padEnd(8);

    console.log(
      `| ${String(result.requestNumber).padEnd(3)} | ${String(result.turn).padEnd(4)} | ${result.phase.padEnd(13)} | ${String(result.messageCount).padEnd(4)} | ${result.lastRole.padEnd(4)} | ${String(result.toolCalls).padEnd(9)} | ${input} | ${output} | ${write} | ${read} | ${hitRate} |`
    );
  }
}

async function runSession(
  baseUrl: string,
  authToken: string,
  model: string,
  preferredProvider?: string
): Promise<RequestResult[]> {
  const label = preferredProvider ? `preferred ${preferredProvider}` : 'default routing';
  const taskId = `cache-diag-${Date.now()}`;
  const sessionSystemMessage: TextMessage = {
    role: 'system',
    content: `CACHE_DIAG_RUN_ID: ${taskId}\n${SYSTEM_MESSAGE.content}`,
  };

  console.log(`\n--- ${model} via ${label} ---`);
  console.log(`Task ID: ${taskId}`);
  console.log(`Fixture: realistic system prompt + ${TOOL_DEFINITIONS.length} tools`);

  const messages: RequestMessage[] = [sessionSystemMessage];
  const results: RequestResult[] = [];

  for (let turnIndex = 0; turnIndex < TURNS.length; turnIndex++) {
    const turnNumber = turnIndex + 1;
    messages.push(TURNS[turnIndex]);
    let toolRound = 0;
    let sawToolCallForTurn = false;

    while (true) {
      toolRound += 1;
      if (toolRound > 6) {
        throw new Error(`Exceeded tool loop limit on turn ${turnNumber}`);
      }

      const lastMessage = messages.at(-1);
      const phase: RequestPhase = lastMessage?.role === 'tool' ? 'tool-followup' : 'user';

      console.log(
        `\nTurn ${turnNumber}, ${phase}, request ${results.length + 1}: ${messages.length} messages, last=${lastMessage?.role ?? 'unknown'}, sending...`
      );

      const step = await streamStep(baseUrl, authToken, model, taskId, messages, preferredProvider);
      const result: RequestResult = {
        requestNumber: results.length + 1,
        turn: turnNumber,
        phase,
        messageCount: messages.length,
        lastRole: lastMessage?.role ?? 'user',
        toolCalls: step.toolCallsPayload.length,
        elapsedMs: step.elapsedMs,
        responseText: step.responseText,
        promptTokens: step.promptTokens,
        completionTokens: step.completionTokens,
        cachedTokens: step.cachedTokens,
        cacheWriteTokens: step.cacheWriteTokens,
      };

      console.log(
        `  Response (${(result.elapsedMs / 1000).toFixed(1)}s): "${truncate(result.responseText, 80)}"`
      );
      console.log(
        `  Usage: input=${result.promptTokens ?? 'N/A'} output=${result.completionTokens ?? 'N/A'} cached_read=${result.cachedTokens ?? 'N/A'} cached_write=${result.cacheWriteTokens ?? 'N/A'} tool_calls=${result.toolCalls}`
      );
      console.log(`  Cache hit rate: ${cacheHitRate(result.promptTokens, result.cachedTokens)}`);

      results.push(result);

      if (step.toolCallsPayload.length === 0) {
        if (!sawToolCallForTurn) {
          throw new Error(
            `Turn ${turnNumber} completed without any tool calls. The repro harness requires tool_result follow-up requests to mirror production caching.`
          );
        }
        messages.push({ role: 'assistant', content: step.responseText });
        break;
      }

      if (phase === 'tool-followup' && toolRound >= 2) {
        const fallbackAssistantText =
          step.responseText ||
          'Tool loop truncated after the cache-bearing follow-up request for diagnostic stability.';
        console.log('  Truncating additional tool loop after cache-bearing follow-up request.');
        messages.push({ role: 'assistant', content: fallbackAssistantText });
        break;
      }

      sawToolCallForTurn = true;
      messages.push(step.assistantMessage);
      const toolMessages = executeToolCalls(step.toolCallsPayload);
      messages.push(...toolMessages);
    }
  }

  printSummary(results, label);

  const hasCacheHit = results.some(result => (result.cachedTokens ?? 0) > 0);
  const shouldRequireCacheHit = preferredProvider !== 'anthropic';

  if (shouldRequireCacheHit && !hasCacheHit) {
    throw new Error(`No cache hits observed for ${label}`);
  }

  return results;
}

/**
 * Cache diagnostic E2E test script.
 *
 * Uses a realistic Kilo request fixture and a production-shaped tool loop so the
 * last cacheable message regularly becomes a tool result, matching the high-hit
 * production sessions. This avoids the old false-negative harness that used
 * `tool_choice: "none"`, never produced tool messages, and stayed below Opus's
 * cacheable token threshold.
 *
 * @param email - google_user_email of a user in the local DB (required)
 * @param model - OpenRouter model ID (optional, default: anthropic/claude-opus-4.6)
 * @param provider - Preferred OpenRouter inference provider (optional).
 *                   Use "amazon-bedrock" or "anthropic".
 *                   Use "compare" to run both preferences back-to-back.
 */
export async function run(email: string, model?: string, provider?: string): Promise<void> {
  if (!email) {
    console.error('Error: email is required');
    console.log(
      '\nUsage: npx tsx src/scripts/index.ts openrouter test-cache-diag <email> [model] [provider]'
    );
    console.log('\nExamples:');
    console.log('  npx tsx src/scripts/index.ts openrouter test-cache-diag user@example.com');
    console.log(
      '  npx tsx src/scripts/index.ts openrouter test-cache-diag user@example.com anthropic/claude-opus-4.6 amazon-bedrock'
    );
    console.log(
      '  npx tsx src/scripts/index.ts openrouter test-cache-diag user@example.com anthropic/claude-opus-4.6 compare'
    );
    process.exit(1);
  }

  const resolvedModel = model || CLAUDE_OPUS_CURRENT_MODEL_ID;

  try {
    console.log('=== Cache Diagnostic E2E Test ===\n');

    const { authToken, baseUrl } = await authenticateUser(email);
    console.log(`Auth: ${email}`);
    console.log(`Server: ${baseUrl}`);
    console.log(`Workspace: ${toPosixPath(WORKSPACE_ROOT)}`);

    if (provider === 'compare') {
      const providers: Array<'amazon-bedrock' | 'anthropic'> = ['amazon-bedrock', 'anthropic'];
      for (const preferredProvider of providers) {
        await runSession(baseUrl, authToken, resolvedModel, preferredProvider);
      }
    } else {
      await runSession(baseUrl, authToken, resolvedModel, provider);
    }

    console.log('\nCheck server logs for [CacheDiag] and [CacheDiag:response] entries.');
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
