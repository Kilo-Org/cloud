import { Hono, type Context } from 'hono';
import { base64urlToBytes, bytesToBase64url } from '@kilocode/worker-utils/base64url';
import { z } from 'zod';

import { authorize, type Principal } from '../auth';
import { getSessionSyncDOStub } from '../dos/SessionSyncDO';
import { getTenantStub } from '../dos/SessionSyncTenantDO';
import { getPresenceStub } from '../dos/SessionPresenceDO';
import { getRelayStub } from '../dos/SessionRelayDO';
import type { Env } from '../env';
import { ERROR_STATUS, errorBody, sessionIDSchema } from '../protocol';
import { rateLimit } from '../rate-limit';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { LIVE_LIMITS, socketTicket } from './protocol';
import { mintTicket, verifyTicket } from './ticket';
import { phase } from '../metrics';

type C = Context<{ Bindings: Env }>;
export const live = new Hono<{ Bindings: Env }>();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
function error(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
async function principal(c: C): Promise<Principal | Response> {
  const auth = await authorize(c.req.raw, c.env);
  if (auth instanceof Response) return auth;
  return (await rateLimit(c.env.USER_REQUEST_LIMITER, auth.userID)) ?? auth;
}
async function body(c: C, max: number): Promise<unknown> {
  if (!c.req.raw.body) return error('invalid_request', 'A JSON body is required');
  const read = await readBoundedStream(c.req.raw.body as ReadableStream<Uint8Array>, max);
  if (!read.ok) return error('request_too_large', 'The request body is too large', 413);
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes)
    );
  } catch {
    return error('invalid_request', 'The request body is not valid JSON');
  }
}
async function sessionAuth(c: C) {
  const auth = await principal(c);
  if (auth instanceof Response) return auth;
  const id = sessionIDSchema.safeParse(c.req.param('id'));
  if (!id.success) return error('invalid_request', 'Invalid session ID');
  const allowed = await phase(
    c.env,
    'authorizeLive',
    'rpc',
    async () =>
      await getSessionSyncDOStub(c.env, {
        tenant: auth.tenant,
        sessionID: id.data,
      }).authorizeLive({ principal: auth, sessionID: id.data }),
    auth.tenant.type
  );
  if (!allowed.ok) return json(errorBody(allowed.error), ERROR_STATUS[allowed.error.code]);
  return { principal: auth, sessionID: id.data };
}

live.post('/sessions/:id/live-ticket', async c => {
  const auth = await sessionAuth(c);
  if (auth instanceof Response) return auth;
  const input = await body(c, 1024);
  if (input instanceof Response) return input;
  const parsed = z
    .strictObject({ role: z.enum(['viewer', 'controller', 'runner']) })
    .safeParse(input);
  if (!parsed.success) return error('invalid_request', 'A live role is required');
  return json(
    await mintTicket(
      c.req.raw,
      c.env,
      auth.principal,
      'session-relay',
      parsed.data.role,
      auth.sessionID
    )
  );
});

live.get('/sessions/:id/live', async c => {
  const token = socketTicket(c.req.raw);
  const ticket = token ? await verifyTicket(token, c.env, 'session-relay') : undefined;
  if (!ticket || !ticket.sessionID || ticket.sessionID !== c.req.param('id'))
    return error('invalid_ticket', 'A valid session ticket is required', 401);
  const sessionID = ticket.sessionID;
  return phase(
    c.env,
    'relayConnect',
    'rpc',
    () => getRelayStub(c.env, ticket.tenant, sessionID).fetch(c.req.raw),
    ticket.tenant.type
  );
});

live.post('/sessions/:id/commands', async c => {
  const auth = await sessionAuth(c);
  if (auth instanceof Response) return auth;
  const command = await body(c, LIVE_LIMITS.messageBytes);
  if (command instanceof Response) return command;
  const ticket = await mintTicket(
    c.req.raw,
    c.env,
    auth.principal,
    'session-relay',
    'controller',
    auth.sessionID
  );
  return getRelayStub(c.env, auth.principal.tenant, auth.sessionID).command({
    ticket: ticket.ticket,
    command,
  });
});

live.get('/sessions/:id/commands/:commandID', async c => {
  const auth = await sessionAuth(c);
  if (auth instanceof Response) return auth;
  const commandID = z.string().min(1).max(256).safeParse(c.req.param('commandID'));
  if (!commandID.success) return error('invalid_request', 'Invalid command ID');
  const ticket = await mintTicket(
    c.req.raw,
    c.env,
    auth.principal,
    'session-relay',
    'controller',
    auth.sessionID
  );
  return getRelayStub(c.env, auth.principal.tenant, auth.sessionID).commandStatus({
    ticket: ticket.ticket,
    commandID: commandID.data,
  });
});

live.post('/presence/ticket', async c => {
  const auth = await principal(c);
  if (auth instanceof Response) return auth;
  const input = await body(c, 1024);
  if (input instanceof Response) return input;
  const parsed = z
    .strictObject({ role: z.enum(['viewer', 'runner', 'controller']) })
    .safeParse(input);
  if (!parsed.success)
    return error('invalid_request', 'A presence viewer, runner, or controller role is required');
  return json(await mintTicket(c.req.raw, c.env, auth, 'session-presence', parsed.data.role));
});

live.get('/presence', async c => {
  const token = socketTicket(c.req.raw);
  const ticket = token ? await verifyTicket(token, c.env, 'session-presence') : undefined;
  if (!ticket) return error('invalid_ticket', 'A valid presence ticket is required', 401);
  return phase(
    c.env,
    'presenceConnect',
    'rpc',
    () => getPresenceStub(c.env, ticket.userID).fetch(c.req.raw),
    ticket.tenant.type
  );
});

live.post('/presence/instances/:instanceID/commands', async c => {
  const auth = await principal(c);
  if (auth instanceof Response) return auth;
  const instanceID = z.string().min(1).max(128).safeParse(c.req.param('instanceID'));
  if (!instanceID.success) return error('invalid_request', 'Invalid instance ID');
  const input = await body(c, LIVE_LIMITS.messageBytes);
  if (input instanceof Response) return input;
  const parsed = z
    .strictObject({
      channel: z.literal('commands').optional(),
      instanceID: z.string().optional(),
      commandID: z.string().min(1).max(256),
      type: z.string().min(1).max(256),
      body: z.unknown().optional(),
    })
    .safeParse(input);
  if (
    !parsed.success ||
    (parsed.data.instanceID !== undefined && parsed.data.instanceID !== instanceID.data)
  ) {
    return error('invalid_request', 'Invalid instance command');
  }
  const ticket = await mintTicket(c.req.raw, c.env, auth, 'session-presence', 'controller');
  try {
    return await getPresenceStub(c.env, auth.userID).command({
      ticket: ticket.ticket,
      command: { ...parsed.data, channel: 'commands', instanceID: instanceID.data },
    });
  } catch {
    return json(
      {
        commandID: parsed.data.commandID,
        instanceID: instanceID.data,
        status: 'unknown',
        outcome: 'unknown',
      },
      202
    );
  }
});

const cursorSchema = z.strictObject({
  createdAt: z.number().int().nonnegative(),
  target: z.string().max(2048),
});
live.get('/sessions', async c => {
  const auth = await principal(c);
  if (auth instanceof Response) return auth;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .safeParse(c.req.query('limit') ?? 50);
  if (!limit.success) return error('invalid_request', 'Limit must be between 1 and 100');
  let before: z.infer<typeof cursorSchema> | undefined;
  const cursor = c.req.query('cursor');
  if (cursor !== undefined) {
    if (cursor.length > 4096) return error('invalid_request', 'Invalid session cursor');
    try {
      before = cursorSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            base64urlToBytes(cursor)
          )
        )
      );
    } catch {
      return error('invalid_request', 'Invalid session cursor');
    }
  }
  const result = await getTenantStub(c.env, { type: 'user', id: auth.userID }).listCreatedSessions({
    limit: limit.data,
    before,
  });
  if (!result.ok) return json(errorBody(result.error), ERROR_STATUS[result.error.code]);
  const instances = await getPresenceStub(c.env, auth.userID).list();
  return json({
    version: 1,
    items: result.value.items.map(item => ({
      ...item,
      live: instances.some(
        instance =>
          instance.online &&
          instance.tenant.type === item.tenant.type &&
          instance.tenant.id === item.tenant.id &&
          instance.advertisement.sessions.includes(item.sessionID)
      ),
    })),
    cursor: result.value.next
      ? bytesToBase64url(new TextEncoder().encode(JSON.stringify(result.value.next)))
      : null,
  });
});
