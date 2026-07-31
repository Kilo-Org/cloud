import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { collectReplicationHealth } from '@/lib/replication-health';

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function GET(request: Request) {
  const secret = request.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || !secretMatches(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const report = await collectReplicationHealth();

  return NextResponse.json(report);
}
