import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { EXA_API_KEY } from '@/lib/config.server';
import { after } from 'next/server';
import { wrapInSafeNextResponse } from '@/lib/llm-proxy-helpers';

const EXA_BASE_URL = 'https://api.exa.ai';

const ALLOWED_PATHS = new Set(['/search', '/contents', '/findSimilar', '/answer', '/context']);

function extractExaPath(url: URL): string | null {
  const prefix = '/api/exa';
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(prefix.length);
  return ALLOWED_PATHS.has(path) ? path : null;
}

function logExaCost(userId: string, path: string, responseBody: unknown) {
  const body = responseBody as { costDollars?: { total?: number } } | null;
  const cost = body?.costDollars?.total;
  if (cost !== undefined) {
    console.log(`[exa] user=${userId} path=${path} cost=$${cost}`);
  }
}

export async function POST(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;

  const url = new URL(request.url);
  const exaPath = extractExaPath(url);
  if (!exaPath) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${[...ALLOWED_PATHS].join(', ')}` },
      { status: 400 }
    );
  }

  if (!EXA_API_KEY) {
    console.error('[exa] EXA_API_KEY is not configured');
    return NextResponse.json({ error: 'Exa search is not configured' }, { status: 503 });
  }

  const requestBody = await request.text();

  const response = await fetch(`${EXA_BASE_URL}${exaPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': EXA_API_KEY,
    },
    body: requestBody,
    signal: request.signal,
  });

  if (response.status >= 400) {
    console.error(
      `[exa] upstream error: status=${response.status} user=${user.id} path=${exaPath}`
    );
  }

  // For non-streaming responses, extract cost info asynchronously
  const isStreaming = response.headers.get('content-type')?.includes('text/event-stream');
  if (!isStreaming) {
    const cloned = response.clone();
    after(async () => {
      try {
        const body: unknown = await cloned.json();
        logExaCost(user.id, exaPath, body);
      } catch {
        // Response wasn't JSON — nothing to log
      }
    });
  }

  return wrapInSafeNextResponse(response);
}
