import type { NextRequest } from 'next/server';
import { handleLlmProxyRequest } from '@/lib/ai-gateway/handlers/llm-proxy';
import { withRestTiming } from '@/lib/observability/request-timing';

export const POST = withRestTiming('/api/openrouter/[...path]', (request: Request) =>
  handleLlmProxyRequest(request as NextRequest)
);

export const maxDuration = 800;
