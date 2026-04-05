import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { verifySlackRequest } from '@/lib/slack/verify-request';

/**
 * Slack Interactivity endpoint handler
 * Handles interactive components like buttons, modals, shortcuts, etc.
 * @see https://api.slack.com/interactivity/handling
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    console.error('[Slack:Interactivity] Invalid Slack signature');
    return new NextResponse('Invalid signature', { status: 401 });
  }

  return new NextResponse(null, { status: 200 });
}
