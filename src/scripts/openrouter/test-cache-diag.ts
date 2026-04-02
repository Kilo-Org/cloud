import { eq } from 'drizzle-orm';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { generateApiToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { CLAUDE_OPUS_CURRENT_MODEL_ID } from '@/lib/providers/anthropic';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type TurnResult = {
  turn: number;
  messageCount: number;
  elapsedMs: number;
  responseText: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
};

// Realistic tool definitions matching what the Kilo Code extension sends.
// A real "Code" mode request has 14 tools; we include 8 representative ones
// to push the prompt well past the 1,024-token minimum for Anthropic cache.
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read one or more files and return their contents with line numbers for diffing or discussion. Structure: { files: [{ path: "relative/path.ts" }] }. The "path" is required and relative to workspace. Supports text extraction from PDF and DOCX files, but may not handle other binary files properly.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'List of files to read; request related files together when allowed',
            items: {
              type: 'object',
              properties: { path: { type: 'string', description: 'Path to the file to read' } },
              required: ['path'],
              additionalProperties: false,
            },
            minItems: 1,
          },
        },
        required: ['files'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_to_file',
      description:
        "Request to write content to a file. This tool is primarily used for creating new files or for scenarios where a complete rewrite of an existing file is intentionally required. If the file exists, it will be overwritten. If it doesn't exist, it will be created. This tool will automatically create any directories needed to write the file. ALWAYS provide the COMPLETE file content in your response. Partial updates or placeholders are STRICTLY FORBIDDEN.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write, relative to the workspace',
          },
          content: {
            type: 'string',
            description:
              'Full contents that the file should contain with no omissions or line numbers',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_diff',
      description:
        'Apply precise, targeted modifications to an existing file using one or more search/replace blocks. This tool is for surgical edits only; the SEARCH block must exactly match the existing content, including whitespace and indentation. To make multiple targeted changes, provide multiple SEARCH/REPLACE blocks in the diff parameter. Use the read_file tool first if you are not confident in the exact content to search for.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path of the file to modify, relative to the workspace.',
          },
          diff: {
            type: 'string',
            description:
              'A string containing one or more search/replace blocks. Each block must follow this format:\n<<<<<<< SEARCH\n:start_line:[line_number]\n-------\n[exact content to find]\n=======\n[new content to replace with]\n>>>>>>> REPLACE',
          },
        },
        required: ['path', 'diff'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        "Request to execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. For command chaining, use the appropriate chaining syntax for the user's shell. Prefer to execute complex CLI commands over creating executable scripts.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Optional working directory for the command' },
        },
        required: ['command', 'cwd'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context. Craft your regex patterns carefully to balance specificity and flexibility. Use this tool to find code patterns, TODO comments, function definitions, or any text-based information across the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search recursively' },
          regex: { type: 'string', description: 'Rust-compatible regular expression pattern' },
          file_pattern: {
            type: 'string',
            description: 'Optional glob to limit which files are searched',
          },
        },
        required: ['path', 'regex', 'file_pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'Request to list files and directories within the specified directory. If recursive is true, it will list all files and directories recursively. If recursive is false or not provided, it will only list the top-level contents. Do not use this tool to confirm the existence of files you may have created.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path to inspect, relative to the workspace',
          },
          recursive: { type: 'boolean', description: 'Set true to list contents recursively' },
        },
        required: ['path', 'recursive'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codebase_search',
      description:
        "Find files most relevant to the search query using semantic search. Searches based on meaning rather than exact text matches. By default searches entire workspace. Reuse the user's exact wording unless there's a clear reason not to — their phrasing often helps semantic search. Queries MUST be in English. CRITICAL: For ANY exploration of code you haven't examined yet in this conversation, you MUST use this tool FIRST before any other search or file exploration tools.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Meaning-based search query' },
          path: { type: 'string', description: 'Optional subdirectory to limit the search scope' },
        },
        required: ['query', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attempt_completion',
      description:
        "After each tool use, the user will respond with the result of that tool use. Once you've received the results and can confirm that the task is complete, use this tool to present the result of your work to the user. IMPORTANT: This tool CANNOT be used until you've confirmed from the user that any previous tool uses were successful. Before using this tool, you must confirm that you've received successful results from the user for any previous tool uses.",
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'Final result message to deliver to the user' },
        },
        required: ['result'],
        additionalProperties: false,
      },
    },
  },
];

const TURNS: { role: 'user'; content: string }[] = [
  {
    role: 'user',
    content:
      '<task>\nI need you to refactor the authentication module in src/auth/login.ts. The current implementation uses callbacks and I want it converted to async/await. Make sure all error handling is preserved and add proper TypeScript types for the return values.\n</task>\n\n<environment_details>\n# VSCode Visible Files\nsrc/auth/login.ts\n\n# VSCode Open Tabs\nsrc/auth/login.ts\nsrc/auth/types.ts\nsrc/auth/middleware.ts\n\n# Current Time\n2026-03-31T14:00:00.000Z\n</environment_details>',
  },
  {
    role: 'user',
    content:
      'The refactored code looks good but I also need you to update the tests in src/auth/__tests__/login.test.ts to match the new async/await pattern. The tests currently use done() callbacks.',
  },
  {
    role: 'user',
    content:
      'Now please also update the middleware in src/auth/middleware.ts to use the new async login function, and make sure the error handling middleware catches any rejected promises properly.',
  },
];

// Realistic Kilo Code system prompt (abbreviated but representative in token count).
const SYSTEM_MESSAGE: ChatMessage = {
  role: 'system',
  content: `You are Kilo Code, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

====

MARKDOWN RULES

ALL responses MUST show ANY \`language construct\` OR filename reference as clickable, exactly as [\`filename OR language.declaration()\`](relative/file/path.ext:line); line is required for \`syntax\` and optional for filename links.

====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. Use the provider-native tool-calling mechanism. Do not include XML markup or examples.

# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses.
4. After each tool use, the user will respond with the result of that tool use. This result will provide you with the necessary information to continue your task or make further decisions.

====

CAPABILITIES

- You can read and analyze code in various programming languages, and can write clean, efficient, and well-documented code.
- You can analyze project structures and suggest improvements for better organization and maintainability.
- You can debug complex issues by analyzing error messages, stack traces, and application behavior.
- You can provide refactoring suggestions to improve code quality, readability, and performance.
- You can write and update unit tests, integration tests, and end-to-end tests.

====

RULES

- Your current working directory is always the workspace root.
- You cannot \`cd\` into a different directory to complete a task. You are stuck operating from the workspace root.
- Do not use the ~ character or $HOME to refer to the home directory.
- When using the search_files tool, craft your regex patterns carefully to balance specificity and flexibility.
- When creating a new project, organize all new files within a dedicated project directory unless the user specifies otherwise.
- Be sure to consider the type of project (e.g. Python, JavaScript, web application) when determining the appropriate structure and files to include.
- When making changes to code, always consider the context in which the code is being used. Ensure your changes are compatible with the existing codebase.
- Do not ask for more information than necessary. Use the tools provided to accomplish the user's request efficiently.
- When you have completed the task, use the attempt_completion tool to present the result.
- The user may provide feedback, which you can use to make improvements and try again.
- IMPORTANT: You should NEVER end attempt_completion result with a question or request to engage in further conversation.`,
};

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

async function streamTurn(
  baseUrl: string,
  authToken: string,
  model: string,
  taskId: string,
  messages: ChatMessage[]
): Promise<TurnResult & { assistantMessage: ChatMessage }> {
  const startTime = Date.now();

  const response = await fetch(`${baseUrl}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      'x-kilocode-taskid': taskId,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'none',
      stream: true,
      max_tokens: 256,
    }),
  });

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      errorDetail = body.error?.message || body.error || JSON.stringify(body);
    } catch {
      // keep the HTTP status message
    }
    throw new Error(`Request failed: ${errorDetail}`);
  }

  if (!response.body) {
    throw new Error('Response body is null — expected a stream');
  }

  const contentParts: string[] = [];
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedTokens: number | null = null;

  await new Promise<void>((resolve, reject) => {
    const parser = createParser({
      onEvent(event: EventSourceMessage) {
        if (event.data === '[DONE]') {
          resolve();
          return;
        }

        try {
          const chunk = JSON.parse(event.data);

          // Content deltas
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            contentParts.push(delta.content);
          }

          // Usage from final chunk (choices is empty, usage is present)
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? null;
            completionTokens = chunk.usage.completion_tokens ?? null;
            cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? null;
          }
        } catch {
          // skip malformed chunks
        }
      },
    });

    // body is checked for null above; the non-null path is guarded
    const body = response.body;
    if (!body) throw new Error('unreachable');
    const reader = body.getReader();
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

  return {
    turn: 0, // filled in by caller
    messageCount: messages.length,
    elapsedMs,
    responseText,
    promptTokens,
    completionTokens,
    cachedTokens,
    assistantMessage: { role: 'assistant', content: responseText },
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

function cacheHitRate(promptTokens: number | null, cachedTokens: number | null): string {
  if (promptTokens === null || cachedTokens === null || promptTokens === 0) return 'N/A';
  return `${Math.round((cachedTokens / promptTokens) * 100)}%`;
}

function printSummary(results: TurnResult[]) {
  console.log('\n=== Summary ===');
  console.log('| Turn | Messages | Input  | Output | Cached | Hit Rate |');
  console.log('|------|----------|--------|--------|--------|----------|');
  for (const r of results) {
    const input = r.promptTokens !== null ? String(r.promptTokens).padEnd(6) : 'N/A   ';
    const output = r.completionTokens !== null ? String(r.completionTokens).padEnd(6) : 'N/A   ';
    const cached = r.cachedTokens !== null ? String(r.cachedTokens).padEnd(6) : 'N/A   ';
    const hitRate = cacheHitRate(r.promptTokens, r.cachedTokens).padEnd(8);
    console.log(
      `| ${r.turn}    | ${String(r.messageCount).padEnd(8)} | ${input} | ${output} | ${cached} | ${hitRate} |`
    );
  }

  console.log('\nCheck server logs (pnpm dev terminal) for [CacheDiag] entries:');
  console.log('  - [CacheDiag] shows prefixHash, breakpoint, promptCacheKey (pre-request)');
  console.log('  - [CacheDiag:response] shows cacheHitTokens, cacheWriteTokens (post-response)');
  console.log(
    '\nNote: cacheWriteTokens are only visible server-side, not in the client SSE stream.'
  );
}

/**
 * Cache diagnostic E2E test script.
 *
 * Makes multi-turn streaming requests with tools to the local gateway,
 * using the same taskId across turns to exercise the [CacheDiag] logging.
 *
 * @param email - google_user_email of a user in the local DB (required)
 * @param model - OpenRouter model ID (optional, default: anthropic/claude-opus-4.6)
 */
export async function run(email: string, model?: string): Promise<void> {
  if (!email) {
    console.error('Error: email is required');
    console.log('\nUsage: npx tsx src/scripts/index.ts openrouter test-cache-diag <email> [model]');
    console.log('\nExamples:');
    console.log('  npx tsx src/scripts/index.ts openrouter test-cache-diag user@example.com');
    console.log(
      '  npx tsx src/scripts/index.ts openrouter test-cache-diag user@example.com anthropic/claude-sonnet-4.5'
    );
    process.exit(1);
  }

  const resolvedModel = model || CLAUDE_OPUS_CURRENT_MODEL_ID;

  try {
    console.log('=== Cache Diagnostic E2E Test ===\n');

    const { authToken, baseUrl } = await authenticateUser(email);
    console.log(`Auth: ${email}`);
    console.log(`Server: ${baseUrl}`);

    const taskId = `cache-diag-${Date.now()}`;
    console.log(`\n--- ${resolvedModel} ---`);
    console.log(`Task ID: ${taskId}\n`);

    const messages: ChatMessage[] = [SYSTEM_MESSAGE];
    const results: TurnResult[] = [];

    for (let i = 0; i < TURNS.length; i++) {
      const turnNum = i + 1;
      messages.push(TURNS[i]);

      console.log(`Turn ${turnNum}/${TURNS.length}: ${messages.length} messages, sending...`);

      const result = await streamTurn(baseUrl, authToken, resolvedModel, taskId, messages);
      result.turn = turnNum;

      console.log(
        `  Response (${(result.elapsedMs / 1000).toFixed(1)}s): "${truncate(result.responseText, 50)}"`
      );
      console.log(
        `  Usage: input=${result.promptTokens ?? 'N/A'} output=${result.completionTokens ?? 'N/A'} cached=${result.cachedTokens ?? 'N/A'}`
      );
      console.log(`  Cache hit rate: ${cacheHitRate(result.promptTokens, result.cachedTokens)}\n`);

      // Append assistant response for next turn
      messages.push(result.assistantMessage);
      results.push(result);
    }

    printSummary(results);
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
