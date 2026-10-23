import type { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import {
  codeIndexingGoneResponse,
  isCodeIndexingEnabled,
} from '@/lib/code-indexing/availability.server';

export async function POST(request: NextRequest) {
  if (!isCodeIndexingEnabled()) {
    return codeIndexingGoneResponse();
  }

  const body = await request.json();

  return handleTRPCRequest(request, async caller => {
    return caller.codeIndexing.delete(body);
  });
}
