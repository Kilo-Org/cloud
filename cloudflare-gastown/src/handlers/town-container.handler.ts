import type { Context } from 'hono';
import { z } from 'zod';
import type { GastownEnv } from '../gastown.worker';
import { getTownContainerStub } from '../dos/TownContainer.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';

const CONTAINER_LOG = '[town-container.handler]';

/**
 * Proxy a request to the town container's control server and return the response.
 * Preserves the original status code and JSON body.
 */
async function proxyToContainer(
  container: ReturnType<typeof getTownContainerStub>,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const method = init?.method ?? 'GET';
  console.log(`${CONTAINER_LOG} proxyToContainer: ${method} ${path}`);
  if (init?.body) {
    console.log(`${CONTAINER_LOG} proxyToContainer: body=${String(init.body).slice(0, 300)}`);
  }
  try {
    const response = await container.fetch(`http://container${path}`, init);
    const data = await response.text();
    console.log(
      `${CONTAINER_LOG} proxyToContainer: ${method} ${path} -> ${response.status} body=${data.slice(0, 300)}`
    );
    return new Response(data, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`${CONTAINER_LOG} proxyToContainer: EXCEPTION for ${method} ${path}:`, err);
    throw err;
  }
}

/**
 * Forward a start-agent request to the town container's control server.
 * The container control server validates the full StartAgentRequest schema.
 */
export async function handleContainerStartAgent(
  c: Context<GastownEnv>,
  params: { townId: string }
) {
  const body = await parseJsonBody(c);
  if (!body) return c.json(resError('Invalid JSON body'), 400);

  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, '/agents/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Forward a stop-agent request to the town container.
 */
export async function handleContainerStopAgent(
  c: Context<GastownEnv>,
  params: { townId: string; agentId: string }
) {
  const body = await parseJsonBody(c);

  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, `/agents/${params.agentId}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/**
 * Forward a message to a running agent in the container.
 */
export async function handleContainerSendMessage(
  c: Context<GastownEnv>,
  params: { townId: string; agentId: string }
) {
  const body = await parseJsonBody(c);
  if (!body) return c.json(resError('Invalid JSON body'), 400);

  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, `/agents/${params.agentId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Get the status of an agent process in the container.
 */
export async function handleContainerAgentStatus(
  c: Context<GastownEnv>,
  params: { townId: string; agentId: string }
) {
  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, `/agents/${params.agentId}/status`);
}

const ContainerTicketResponse = z.object({
  ticket: z.string(),
  expiresAt: z.string(),
});

/**
 * Get a stream ticket for an agent.
 *
 * The container returns `{ ticket, expiresAt }` directly. This handler
 * wraps the response in the standard success envelope and constructs a
 * stream URL that the frontend can connect to.
 */
export async function handleContainerStreamTicket(
  c: Context<GastownEnv>,
  params: { townId: string; agentId: string }
) {
  const container = getTownContainerStub(c.env, params.townId);
  const response = await container.fetch(
    `http://container/agents/${params.agentId}/stream-ticket`,
    { method: 'POST' }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '(unreadable)');
    console.error(
      `${CONTAINER_LOG} handleContainerStreamTicket: container error ${response.status}: ${text.slice(0, 300)}`
    );
    const statusCode = response.status >= 500 ? 502 : response.status === 404 ? 404 : 400;
    return c.json(resError(`Container error: ${response.status}`), statusCode);
  }

  const raw = await response.json();
  const parsed = ContainerTicketResponse.safeParse(raw);
  if (!parsed.success) {
    console.error(
      `${CONTAINER_LOG} handleContainerStreamTicket: unexpected container response`,
      raw
    );
    return c.json(resError('Unexpected container response'), 502);
  }

  // Return just the path — the caller (tRPC router on the Next.js server)
  // constructs the full WS URL using its known GASTOWN_SERVICE_URL, which
  // resolves to the correct host in both local dev and production.
  const streamPath = `/api/towns/${params.townId}/container/agents/${params.agentId}/stream`;

  return c.json(resSuccess({ url: streamPath, ticket: parsed.data.ticket }), 200);
}

/**
 * Container health check.
 */
export async function handleContainerHealth(c: Context<GastownEnv>, params: { townId: string }) {
  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, '/health');
}
