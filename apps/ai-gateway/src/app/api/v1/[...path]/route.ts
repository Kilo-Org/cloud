import type { NextRequest } from 'next/server';
import { handleLlmProxyRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const POST = withRestTiming('/api/v1/[...path]', (request: Request) =>
  handleLlmProxyRequest(request as NextRequest)
);

export const maxDuration = 800;
