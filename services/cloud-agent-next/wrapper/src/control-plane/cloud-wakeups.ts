import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  cloudWakeupCommandSchema,
  type CloudWakeupReply,
} from '../../../src/shared/cloud-wakeup.js';
import type {
  ControlPlaneRouteSpec,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import pluginSource from './cloud-wakeup-plugin.mjs' with { type: 'text' };

const requestSchema = z
  .object({ sessionID: z.string().min(1).max(128), command: cloudWakeupCommandSchema })
  .strict();
const unavailable = { ok: false, error: 'Could not confirm the Cloud wakeup.' } as const;

export function createWrapperWakeups(options: {
  send(frame: ControlPlaneWrapperFrame): void;
  clear(spec: ControlPlaneRouteSpec): Promise<void> | undefined;
}) {
  const credentials = new Map<string, string>();
  const routes = new Map<
    string,
    { spec: ControlPlaneRouteSpec; key: string; pendingId?: string }
  >();
  const requests = new Map<string, (result: CloudWakeupReply) => void>();
  let endpoint: ReturnType<typeof start> | undefined;
  let plugin: Promise<{ root: string; package: string }> | undefined;

  function start() {
    return Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 64 * 1024,
      async fetch(request) {
        const reject = (error: string, status: number) =>
          Response.json({ ok: false, error }, { status });
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/wakeups')
          return new Response(null, { status: 404 });
        const presented = request.headers.get('authorization');
        if (!presented?.startsWith('Bearer ') || presented.length !== 50)
          return reject('Invalid runtime secret.', 401);
        const token = Buffer.from(presented.slice(7));
        const input = requestSchema.safeParse(await request.json().catch(() => null));
        if (!input.success) return reject('Invalid wakeup request.', 400);
        const entry = routes.get(input.data.sessionID);
        const spec = entry?.spec;
        const expected = entry ? credentials.get(entry.key) : undefined;
        if (
          !expected ||
          token.byteLength !== expected.length ||
          !timingSafeEqual(Buffer.from(expected), token)
        )
          return reject('Invalid runtime secret or unknown root chat.', 403);
        if (!entry || !spec?.cloudWakeup || spec.kiloSessionId !== input.data.sessionID)
          return reject('Cloud wakeups require an eligible root chat.', 403);
        const requestId = crypto.randomUUID();
        const result = Promise.withResolvers<CloudWakeupReply>();
        if (requests.size >= 64) return reject('Too many wakeup requests.', 503);
        requests.set(requestId, result.resolve);
        const timer = setTimeout(() => result.resolve(unavailable), 10_000);
        try {
          options.send({
            type: 'wakeup.request',
            requestId,
            sessionId: spec.sessionId,
            kiloSessionId: spec.kiloSessionId,
            command: input.data.command,
          });
          const reply = await result.promise;
          if (reply.ok && reply.wakeup.state === 'pending') entry.pendingId = reply.wakeup.id;
          return Response.json(reply);
        } finally {
          clearTimeout(timer);
          requests.delete(requestId);
        }
      },
    });
  }

  async function install() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cloud-wakeup-'));
    const directory = path.join(root, 'cloud-wakeup');
    try {
      await mkdir(directory);
      await writeFile(path.join(directory, 'server.mjs'), pluginSource, { mode: 0o644 });
      await chmod(root, 0o755);
      return { root, package: pathToFileURL(directory).href };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  function disconnected() {
    for (const resolve of requests.values()) resolve(unavailable);
    requests.clear();
  }

  return {
    async environment(spec: ControlPlaneRouteSpec, key: string, env: Record<string, string>) {
      const trustedEnv = { ...env };
      delete trustedEnv.KILO_CLOUD_WAKEUP_PLUGIN;
      if (!spec.cloudWakeup && !credentials.has(key)) return trustedEnv;
      endpoint ??= start();
      plugin ??= install().catch(error => {
        plugin = undefined;
        throw error;
      });
      let secret = credentials.get(key);
      if (!secret) {
        secret = randomBytes(32).toString('base64url');
        credentials.set(key, secret);
      }
      return {
        ...trustedEnv,
        KILO_CLOUD_WAKEUP_PLUGIN: JSON.stringify({
          package: (await plugin).package,
          options: { url: new URL('/wakeups', endpoint.url).href, secret },
        }),
      };
    },
    register(spec: ControlPlaneRouteSpec, key: string) {
      if (spec.cloudWakeup && !routes.has(spec.kiloSessionId))
        routes.set(spec.kiloSessionId, { spec, key });
    },
    release(sessionId: string) {
      for (const [id, entry] of routes) if (entry.spec.sessionId === sessionId) routes.delete(id);
    },
    result(frame: Extract<ControlPlaneWrapperFrame, { type: 'wakeup.result' }>) {
      requests.get(frame.requestId)?.(frame.result);
    },
    async end(sessionId: string, id: string) {
      for (const entry of routes.values()) {
        if (entry.spec.sessionId !== sessionId || entry.pendingId !== id) continue;
        delete entry.pendingId;
        await options.clear(entry.spec);
      }
    },
    disconnected,
    async stop() {
      disconnected();
      await endpoint?.stop(true);
      if (plugin) await rm((await plugin).root, { recursive: true, force: true });
    },
    ports: () => (endpoint?.port === undefined ? [] : [endpoint.port]),
  };
}
