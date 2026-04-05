import type { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

export async function POST(request: NextRequest) {
  const body = await request.json();

  return handleTRPCRequest(request, async caller => {
    return caller.codeIndexing.delete(body);
  });
}
