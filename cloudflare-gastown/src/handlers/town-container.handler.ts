import type { Context } from 'hono';
import type { GastownEnv } from '../gastown.worker';
import { getTownContainerStub } from '../dos/TownContainer.do';
import { resError } from '../util/res.util';
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

/**
 * Get a WebSocket stream ticket for an agent.
 */
export async function handleContainerStreamTicket(
  c: Context<GastownEnv>,
  params: { townId: string; agentId: string }
) {
  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, `/agents/${params.agentId}/stream-ticket`, {
    method: 'POST',
  });
}

/**
 * Container health check.
 */
export async function handleContainerHealth(c: Context<GastownEnv>, params: { townId: string }) {
  const container = getTownContainerStub(c.env, params.townId);
  return proxyToContainer(container, '/health');
}
