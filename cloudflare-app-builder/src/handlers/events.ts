import { logger, formatError } from '../utils/logger';
import { verifyEventTicket } from '../utils/auth';
import type { Env } from '../types';
import type { PreviewDO } from '../preview-do';

function getPreviewDO(appId: string, env: Env): DurableObjectStub<PreviewDO> {
  const id = env.PREVIEW.idFromName(appId);
  return env.PREVIEW.get(id);
}

/**
 * Handle SSE event stream requests.
 * Authenticates via JWT ticket (query param), then subscribes to PreviewDO events.
 *
 * GET /apps/{appId}/events?ticket=xxx
 */
export async function handleEvents(request: Request, env: Env, appId: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const ticket = url.searchParams.get('ticket');

    if (!ticket) {
      return new Response(JSON.stringify({ error: 'missing_ticket' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!env.APP_BUILDER_TICKET_SECRET) {
      logger.error('APP_BUILDER_TICKET_SECRET not configured');
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = verifyEventTicket(ticket, env.APP_BUILDER_TICKET_SECRET);
    if (!result.valid) {
      return new Response(JSON.stringify({ error: 'invalid_ticket', message: result.error }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify the ticket's projectId matches the URL's appId
    if (result.projectId !== appId) {
      return new Response(JSON.stringify({ error: 'ticket_project_mismatch' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const previewStub = getPreviewDO(appId, env);
    const stream = await previewStub.subscribeEvents();

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    logger.error('Events handler error', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
