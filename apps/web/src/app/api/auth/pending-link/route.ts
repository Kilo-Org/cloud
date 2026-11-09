import { NextResponse } from 'next/server';
import {
  getPendingLinkBySecret,
  readPendingLinkSecret,
  summarizePendingLink,
} from '@/lib/auth/pending-link';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

export const GET = withRestTiming('/api/auth/pending-link', async () => {
  const secret = await readPendingLinkSecret();
  const row = secret ? await getPendingLinkBySecret(secret) : null;
  if (!row) {
    return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
  }
  const summary = await summarizePendingLink(row);
  return NextResponse.json({
    provider: summary.provider,
    email: summary.email,
    methods: summary.methods,
    emailCode: summary.emailCode,
    expiresAt: summary.expiresAt,
  });
});
