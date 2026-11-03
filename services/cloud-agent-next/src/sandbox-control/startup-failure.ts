import { z } from 'zod';
import type { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import { parseSandboxLaunchBearer, verifySandboxLaunchCredential } from './credential.js';
import { getSandboxControlStub, isSandboxControlId } from './stub.js';

export const STARTUP_FAILURES = {
  artifact_unavailable: { exitCode: 70, reason: null },
  artifact_unauthorized: { exitCode: 71, reason: 'runtime_artifact_unauthorized' },
  base_incompatible: { exitCode: 72, reason: null },
  artifact_invalid: { exitCode: 73, reason: 'runtime_artifact_invalid' },
  install_interrupted: { exitCode: 74, reason: null },
  deadline_exceeded: { exitCode: 75, reason: null },
  cli_probe_failed: { exitCode: 76, reason: 'runtime_cli_probe_failed' },
  supervisor_missing: { exitCode: 77, reason: 'runtime_supervisor_missing' },
} as const;

export type StartupFailureCode = keyof typeof STARTUP_FAILURES;

export const startupFailureReportSchema = z
  .object({
    allocationId: z.uuid(),
    code: z.enum(Object.keys(STARTUP_FAILURES) as [StartupFailureCode, ...StartupFailureCode[]]),
  })
  .strict();

/** Check the signed launch binding before looking up a Durable Object. */
export function registerStartupFailureRoute(app: Hono<HonoContext>): void {
  app.post('/sandbox-control/:sandboxId/startup-failure', async c => {
    const sandboxId = c.req.param('sandboxId');
    if (!isSandboxControlId(sandboxId)) return c.text('Invalid sandboxId', 400);
    const token = parseSandboxLaunchBearer(c.req.header('Authorization') ?? null);
    if (token === null) return c.text('Unauthorized', 401);
    const secret = await resolveSecret(c.env.NEXTAUTH_SECRET);
    if (!secret) return c.text('Authentication unavailable', 503);
    const launch = verifySandboxLaunchCredential(token, secret);
    if (launch === null || launch.sandboxId !== sandboxId) return c.text('Unauthorized', 401);
    // Streaming limit also applies when Content-Length is absent or incorrect.
    const stream: ReadableStream<Uint8Array> | null = c.req.raw.body;
    const reader = stream?.getReader();
    if (!reader) return c.text('Invalid startup report', 400);
    let text = '';
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1024) return c.text('Body too large', 413);
        text += decoder.decode(part.value, { stream: true });
      }
      const report = startupFailureReportSchema.safeParse(JSON.parse(text + decoder.decode()));
      if (!report.success || report.data.allocationId !== launch.allocationId)
        return c.text('Invalid startup report', 400);
      const accepted = await getSandboxControlStub(c.env, sandboxId).reportStartupFailure({
        ...report.data,
        credential: launch.credential,
      });
      return c.body(null, accepted ? 204 : 409);
    } catch {
      return c.text('Invalid startup report', 400);
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  });
}
