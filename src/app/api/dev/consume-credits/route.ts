import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { findUserById } from '@/lib/user';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { countAndStoreUsage, type MicrodollarUsageContext } from '@/lib/processUsage';
import { captureException } from '@sentry/nextjs';
import { getFraudDetectionHeaders } from '@/lib/utils';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Check if we're in development mode
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development mode' },
      { status: 403 }
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  try {
    const body = await request.json();
    const { dollarAmount } = body;

    if (typeof dollarAmount !== 'number' || dollarAmount <= 0) {
      return NextResponse.json({ error: 'Invalid dollar amount' }, { status: 400 });
    }

    const kiloUserId = user.id;

    // Verify user exists (should always be true since we got it from auth)
    const userRecord = await findUserById(kiloUserId);
    if (!userRecord) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Convert dollars to microdollars
    const microdollarsToConsume = Math.ceil(dollarAmount * 1_000_000);

    // Create a mock response with usage data
    const mockResponseBody = JSON.stringify({
      model: 'manual-consumption',
      usage: {
        cost: dollarAmount,
        is_byok: false,
        cost_details: { upstream_inference_cost: dollarAmount },
        completion_tokens: 0,
        completion_tokens_details: { reasoning_tokens: 0 },
        prompt_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
        total_tokens: 0,
      },
      choices: [{ message: { content: `Consumed $${dollarAmount}` } }],
    });

    const mockResponse = new Response(mockResponseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    // Create usage context with extracted properties
    const usageContext: MicrodollarUsageContext = {
      kiloUserId,
      fraudHeaders: getFraudDetectionHeaders(
        new Headers({
          'user-agent': 'dev-tools',
        })
      ),
      provider: 'dev-tools',
      requested_model: 'manual-consumption',
      promptInfo: {
        system_prompt_prefix: '',
        system_prompt_length: 0,
        user_prompt_prefix: `Consume $${dollarAmount}`.slice(0, 100),
      },
      max_tokens: null,
      has_middle_out_transform: null,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      isStreaming: false,
      prior_microdollar_usage: user.microdollars_used,
      posthog_distinct_id: user.google_user_email,
      project_id: null,
      status_code: 200,
      editor_name: null,
      machine_id: null,
      user_byok: false,
      has_tools: false,
    };

    // Use the existing countAndStoreUsage function
    await countAndStoreUsage(mockResponse, usageContext, undefined);

    // Reset the balance cache using the proper function
    await forceImmediateExpirationRecomputation(kiloUserId);

    console.log(
      `Consumed ${dollarAmount} dollars (${microdollarsToConsume} microdollars) for user ${kiloUserId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error consuming credits:', error);
    captureException(error, {
      tags: { source: 'dev_consume_credits_api' },
      extra: { userId: user.id },
      level: 'error',
    });
    return NextResponse.json({ error: 'Failed to consume credits' }, { status: 500 });
  }
}
