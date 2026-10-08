import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

export async function POST(request: NextRequest) {
  const body: unknown = await request.json().catch(() => undefined);
  if (body === undefined) {
    return NextResponse.json(
      { error: 'Invalid JSON body', message: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  return handleTRPCRequest(request, async caller => {
    // Targeted cast: body is untrusted JSON input, tRPC validates shape.
    return caller.codeIndexing.search(body as never);
  });
}
