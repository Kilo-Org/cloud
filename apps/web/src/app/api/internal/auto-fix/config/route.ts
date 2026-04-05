/**
 * Internal API Endpoint: Get Auto Fix Configuration
 *
 * Called by:
 * - Auto Fix Orchestrator (Cloudflare Worker) to get config for PR creation
 *
 * Process:
 * 1. Get ticket and agent config from database
 * 2. Generate GitHub token if available
 * 3. Return configuration for DO to use
 *
 * URL: POST /api/internal/auto-fix/config
 * Protected by internal API secret
 *
 * Core logic lives in get-fix-config.ts so the pr-callback route
 * can call it directly without a self-referencing HTTP fetch.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { errorExceptInTest } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { getFixConfig } from '@/lib/auto-fix/github/get-fix-config';

export async function POST(req: NextRequest) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: { ticketId?: string } = await req.json();
    const { ticketId } = body;

    if (!ticketId) {
      return NextResponse.json({ error: 'Missing required field: ticketId' }, { status: 400 });
    }

    const result = await getFixConfig(ticketId);

    if (result.ok) {
      return NextResponse.json({
        githubToken: result.githubToken,
        config: result.config,
      });
    }

    return NextResponse.json({ error: result.error }, { status: result.status });
  } catch (error) {
    errorExceptInTest('[auto-fix-config] Error getting config:', error);
    captureException(error, {
      tags: { source: 'auto-fix-config-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to get auto-fix config',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
