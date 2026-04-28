import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { after } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { EXA_API_KEY } from '@/lib/config.server';
import {
  getExaMonthlyUsage,
  getExaFreeAllowanceMicrodollars,
  recordExaUsage,
} from '@/lib/exa-usage';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { readDb } from '@/lib/drizzle';
import { captureException } from '@sentry/nextjs';

const EXA_BASE_URL = 'https://api.exa.ai';
const EXA_SEARCH_PATH = '/search';
const MCP_PROTOCOL_VERSION = '2024-11-05';

const WEB_SEARCH_TOOL = {
  name: 'web_search_exa',
  description:
    'Search the web using Exa AI - performs real-time web searches and can scrape content from specific URLs. Provides up-to-date information for current events and recent data. Returns the content from the most relevant websites.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      type: {
        type: 'string',
        enum: ['auto', 'fast', 'deep'],
        description: 'Search type - auto (balanced), fast (quick), deep (comprehensive)',
      },
      numResults: { type: 'number', description: 'Number of results (default 8)' },
      livecrawl: {
        type: 'string',
        enum: ['fallback', 'preferred'],
        description:
          'Live crawl mode - fallback uses live crawling as backup, preferred prioritizes live crawling',
      },
      contextMaxCharacters: {
        type: 'number',
        description: 'Maximum characters of content returned per result',
      },
    },
    required: ['query'],
  },
};

const CODE_CONTEXT_TOOL = {
  name: 'get_code_context_exa',
  description:
    'Search and get relevant context for any programming task using Exa Code API. Provides code examples, documentation and API references optimized for finding specific programming patterns and solutions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Programming query' },
      tokensNum: {
        type: 'number',
        description: 'Number of tokens to return (default 5000)',
      },
    },
    required: ['query'],
  },
};

const TOOLS = [WEB_SEARCH_TOOL, CODE_CONTEXT_TOOL];

type JsonRpcId = number | string | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

// JSON-RPC 2.0 error codes
// -32601: Method not found
// -32602: Invalid params
// -32603: Internal error
// -32000 to -32099: Server-defined errors
const ERROR_METHOD_NOT_FOUND = -32601;
const ERROR_INVALID_PARAMS = -32602;
const ERROR_INTERNAL = -32603;
const ERROR_SERVER = -32000;

function sseResponse(payload: unknown, status = 200): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'content-encoding': 'identity',
    },
  });
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

type BuildSearchBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

function buildSearchBody(toolName: string, args: Record<string, unknown>): BuildSearchBodyResult {
  if (toolName === 'web_search_exa') {
    const query = args.query;
    if (typeof query !== 'string' || query.length === 0) {
      return { ok: false, message: "missing or invalid 'query' argument" };
    }
    const contextMaxCharacters =
      typeof args.contextMaxCharacters === 'number' ? args.contextMaxCharacters : undefined;
    const body: Record<string, unknown> = {
      query,
      numResults: typeof args.numResults === 'number' ? args.numResults : 8,
      type: typeof args.type === 'string' ? args.type : 'auto',
      livecrawl: typeof args.livecrawl === 'string' ? args.livecrawl : 'fallback',
      contents: {
        text: contextMaxCharacters !== undefined ? { maxCharacters: contextMaxCharacters } : true,
        highlights: true,
      },
    };
    return { ok: true, body };
  }
  if (toolName === 'get_code_context_exa') {
    const query = args.query;
    if (typeof query !== 'string' || query.length === 0) {
      return { ok: false, message: "missing or invalid 'query' argument" };
    }
    const tokensNum = typeof args.tokensNum === 'number' ? args.tokensNum : 5000;
    const body: Record<string, unknown> = {
      query,
      numResults: 5,
      type: 'auto',
      contents: { text: { maxCharacters: tokensNum * 4 } },
    };
    return { ok: true, body };
  }
  return { ok: false, message: `Unknown tool: ${toolName}` };
}

function extractCostDollars(responseBody: unknown): number | undefined {
  const body = responseBody as { costDollars?: { total?: number } } | null;
  return body?.costDollars?.total;
}

export async function POST(request: NextRequest) {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Request body must be a JSON-RPC object' }, { status: 400 });
  }
  const rpcRequest = parsed as JsonRpcRequest;

  const { id, method, params } = rpcRequest;
  const isNotification = id === undefined || id === null;

  // Notifications (no id) get 202 Accepted with no body per MCP streamable HTTP spec.
  if (isNotification) {
    return new Response(null, { status: 202 });
  }

  if (method === 'initialize') {
    return sseResponse(
      jsonRpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'kilo-exa-mcp', version: '1.0.0' },
      })
    );
  }

  if (method === 'tools/list') {
    return sseResponse(jsonRpcResult(id, { tools: TOOLS }));
  }

  if (method !== 'tools/call') {
    return sseResponse(
      jsonRpcError(id, ERROR_METHOD_NOT_FOUND, `Method not found: ${method ?? 'unknown'}`)
    );
  }

  const callParams = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  const toolName = callParams.name;
  const args = callParams.arguments ?? {};
  if (typeof toolName !== 'string') {
    return sseResponse(jsonRpcError(id, ERROR_INVALID_PARAMS, "Missing 'name' parameter"));
  }

  const built = buildSearchBody(toolName, args);
  if (!built.ok) {
    return sseResponse(jsonRpcError(id, ERROR_INVALID_PARAMS, built.message));
  }

  if (!EXA_API_KEY) {
    captureException(new Error('EXA_API_KEY is not configured'));
    return sseResponse(jsonRpcError(id, ERROR_INTERNAL, 'Internal Server Error'));
  }

  const { usage: monthlyUsage, freeAllowance: storedAllowance } = await getExaMonthlyUsage(
    user.id,
    readDb
  );
  const allowance = storedAllowance ?? getExaFreeAllowanceMicrodollars(new Date(), user);
  const isPaidRequest = monthlyUsage >= allowance;

  if (isPaidRequest) {
    const { balance } = await getBalanceAndOrgSettings(organizationId, user, readDb);
    if (balance <= 0) {
      return sseResponse(
        jsonRpcError(
          id,
          ERROR_SERVER,
          'Exa free allowance exhausted and no credit balance available'
        )
      );
    }
  }

  const upstream = await fetch(`${EXA_BASE_URL}${EXA_SEARCH_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': EXA_API_KEY,
    },
    body: JSON.stringify(built.body),
    signal: request.signal,
  });

  if (upstream.status >= 400) {
    // Log only fields that are known to be safe (numeric status, validated IDs).
    // toolName is user-controlled, so report it via Sentry tags instead of console.
    console.error(`[exa-mcp] upstream error: status=${upstream.status}`);
    captureException(new Error(`Exa upstream error (status ${upstream.status})`), {
      tags: { route: '/api/exa/mcp', tool: toolName },
      extra: { userId: user.id },
    });
    let message = `Exa upstream error (status ${upstream.status})`;
    try {
      const errBody = (await upstream.clone().json()) as {
        error?: string;
        message?: string;
      } | null;
      if (errBody?.error) message = errBody.error;
      else if (errBody?.message) message = errBody.message;
    } catch {
      // Ignore non-JSON error bodies; keep the default message.
    }
    return sseResponse(jsonRpcError(id, ERROR_SERVER, message));
  }

  let upstreamBody: unknown;
  try {
    upstreamBody = await upstream.json();
  } catch (error) {
    captureException(error, {
      tags: { route: '/api/exa/mcp', tool: toolName },
      extra: { userId: user.id },
    });
    return sseResponse(jsonRpcError(id, ERROR_INTERNAL, 'Invalid upstream response'));
  }

  const costDollars = extractCostDollars(upstreamBody);

  after(async () => {
    if (costDollars === undefined || costDollars <= 0) return;
    try {
      const costMicrodollars = Math.round(costDollars * 1_000_000);
      await recordExaUsage({
        userId: user.id,
        organizationId,
        path: EXA_SEARCH_PATH,
        costMicrodollars,
        chargedToBalance: isPaidRequest,
        freeAllowanceMicrodollars: allowance,
      });
    } catch (error) {
      captureException(error, {
        tags: { route: '/api/exa/mcp', tool: toolName },
        extra: { userId: user.id },
      });
    }
  });

  return sseResponse(
    jsonRpcResult(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(upstreamBody),
        },
      ],
    })
  );
}
