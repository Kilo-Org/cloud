import type { NextRequest } from 'next/server';
import { after, NextResponse } from 'next/server';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { bot_requests } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { fetchFinalAssistantTextWithRetries } from '@/lib/cloud-agent-next/session-result';
import { bot } from '@/lib/bot';

type ExecutionCallbackPayload = {
  sessionId: string;
  cloudAgentSessionId: string;
  executionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  kiloSessionId?: string;
  lastSeenBranch?: string;
};

async function getBotRequest(botRequestId: string) {
  const [request] = await db
    .select()
    .from(bot_requests)
    .where(eq(bot_requests.id, botRequestId))
    .limit(1);

  return request ?? null;
}

async function completeBotRequest(params: {
  botRequestId: string;
  expectedCloudAgentSessionId: string;
  responseTimeMs: number;
}) {
  const [row] = await db
    .update(bot_requests)
    .set({
      status: 'completed',
      response_time_ms: params.responseTimeMs,
    })
    .where(
      and(
        eq(bot_requests.id, params.botRequestId),
        eq(bot_requests.cloud_agent_session_id, params.expectedCloudAgentSessionId),
        eq(bot_requests.status, 'pending')
      )
    )
    .returning({ id: bot_requests.id });

  return row ?? null;
}

async function failBotRequest(params: {
  botRequestId: string;
  expectedCloudAgentSessionId: string;
  errorMessage: string;
  responseTimeMs: number;
}) {
  const [row] = await db
    .update(bot_requests)
    .set({
      status: 'error',
      error_message: params.errorMessage,
      response_time_ms: params.responseTimeMs,
    })
    .where(
      and(
        eq(bot_requests.id, params.botRequestId),
        eq(bot_requests.cloud_agent_session_id, params.expectedCloudAgentSessionId),
        eq(bot_requests.status, 'pending')
      )
    )
    .returning({ id: bot_requests.id });

  return row ?? null;
}

async function postSlackThreadMessage(threadId: string, markdown: string): Promise<void> {
  await bot.initialize();
  const slackAdapter = bot.getAdapter('slack');
  await slackAdapter.postMessage(threadId, { markdown });
}

function formatFailureMessage(payload: ExecutionCallbackPayload): string {
  if (payload.status === 'interrupted') {
    return `Cloud Agent session stopped before finishing: ${payload.errorMessage ?? 'unknown reason'}`;
  }

  return `Cloud Agent session failed: ${payload.errorMessage ?? 'unknown error'}`;
}

async function handleCompletedCallback(
  botRequestId: string,
  payload: ExecutionCallbackPayload,
  startedAt: number,
  requestRow: NonNullable<Awaited<ReturnType<typeof getBotRequest>>>
) {
  if (!payload.kiloSessionId) {
    const errorMessage = 'Cloud Agent completed but no kilo session id was provided.';
    const updated = await failBotRequest({
      botRequestId,
      expectedCloudAgentSessionId: payload.cloudAgentSessionId,
      errorMessage,
      responseTimeMs: Date.now() - startedAt,
    });

    if (updated) {
      await postSlackThreadMessage(requestRow.platform_thread_id, errorMessage);
    }
    return;
  }

  const finalMessage = await fetchFinalAssistantTextWithRetries({
    kiloSessionId: payload.kiloSessionId,
    userId: requestRow.created_by,
  });

  if (!finalMessage) {
    const errorMessage =
      'Cloud Agent completed but the final response was not available from session ingest.';
    const updated = await failBotRequest({
      botRequestId,
      expectedCloudAgentSessionId: payload.cloudAgentSessionId,
      errorMessage,
      responseTimeMs: Date.now() - startedAt,
    });

    if (updated) {
      await postSlackThreadMessage(requestRow.platform_thread_id, errorMessage);
    }
    return;
  }

  const updated = await completeBotRequest({
    botRequestId,
    expectedCloudAgentSessionId: payload.cloudAgentSessionId,
    responseTimeMs: Date.now() - startedAt,
  });

  if (!updated) {
    return;
  }

  await postSlackThreadMessage(requestRow.platform_thread_id, finalMessage);
}

async function handleFailedCallback(
  botRequestId: string,
  payload: ExecutionCallbackPayload,
  startedAt: number,
  requestRow: NonNullable<Awaited<ReturnType<typeof getBotRequest>>>
) {
  const errorMessage = formatFailureMessage(payload);
  const updated = await failBotRequest({
    botRequestId,
    expectedCloudAgentSessionId: payload.cloudAgentSessionId,
    errorMessage,
    responseTimeMs: Date.now() - startedAt,
  });

  if (!updated) {
    return;
  }

  await postSlackThreadMessage(requestRow.platform_thread_id, errorMessage);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ botRequestId: string }> }
) {
  try {
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { botRequestId } = await params;
    const payload = (await req.json()) as Partial<ExecutionCallbackPayload>;
    const callbackSessionId = payload.cloudAgentSessionId;

    if (!payload.status || !callbackSessionId) {
      return NextResponse.json(
        { error: 'Missing required fields: status and cloudAgentSessionId' },
        { status: 400 }
      );
    }

    const requestRow = await getBotRequest(botRequestId);
    if (!requestRow) {
      return NextResponse.json({ error: 'Bot request not found' }, { status: 404 });
    }

    if (
      requestRow.cloud_agent_session_id &&
      requestRow.cloud_agent_session_id !== callbackSessionId
    ) {
      return NextResponse.json({ success: true, message: 'Stale callback ignored' });
    }

    if (requestRow.status === 'completed' || requestRow.status === 'error') {
      return NextResponse.json({ success: true, message: 'Bot request already finalized' });
    }

    const startedAt = new Date(requestRow.created_at).getTime();

    after(async () => {
      try {
        if (payload.status === 'completed') {
          await handleCompletedCallback(
            botRequestId,
            { ...(payload as ExecutionCallbackPayload), cloudAgentSessionId: callbackSessionId },
            startedAt,
            requestRow
          );
          return;
        }

        if (payload.status === 'failed' || payload.status === 'interrupted') {
          await handleFailedCallback(
            botRequestId,
            { ...(payload as ExecutionCallbackPayload), cloudAgentSessionId: callbackSessionId },
            startedAt,
            requestRow
          );
          return;
        }

        await failBotRequest({
          botRequestId,
          expectedCloudAgentSessionId: callbackSessionId,
          errorMessage: `Unknown callback status: ${String(payload.status)}`,
          responseTimeMs: Date.now() - startedAt,
        });
      } catch (error) {
        captureException(error, {
          tags: { source: 'bot-session-callback-api' },
          extra: { botRequestId, payload },
        });
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    captureException(error, { tags: { source: 'bot-session-callback-api' } });
    return NextResponse.json(
      {
        error: 'Failed to process callback',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
