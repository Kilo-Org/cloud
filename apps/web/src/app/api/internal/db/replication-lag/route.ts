import { timingSafeEqual } from '@kilocode/encryption';
import { NextResponse } from 'next/server';

import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { collectReplicationHealth } from '@/lib/replication-health';

export async function GET(request: Request) {
  const secret = request.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || !secret || !timingSafeEqual(secret, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const report = await collectReplicationHealth();

  return NextResponse.json(report);
}
