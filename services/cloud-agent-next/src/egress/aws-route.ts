import { forwardResolvedScmCapability } from '../scm-broker/managed-forwarding.js';
import type { Hono } from 'hono';
import { readAwsResponse } from '@kilocode/worker-utils/aws-client';
import {
  AWS_EGRESS_CREDENTIAL_HEADER,
  AWS_EGRESS_IDENTITY_HEADER,
  AWS_EGRESS_TARGET_HEADER,
} from '@kilocode/worker-utils/aws-egress';
import { cleanEgressHeaders } from '@kilocode/worker-utils/egress-http';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';
import { isSafeSandboxId } from '../shared/control-plane-credential.js';
import { logger } from '../logger.js';

export async function handleAwsEgress(
  request: Request,
  env: Env,
  sandboxId: string,
  operation: string
): Promise<Response> {
  const credential = request.headers.get(AWS_EGRESS_CREDENTIAL_HEADER);
  const identity = request.headers.get(AWS_EGRESS_IDENTITY_HEADER);
  if (
    !isSafeSandboxId(sandboxId) ||
    !credential ||
    credential.length > 4096 ||
    !identity ||
    !/^[a-f0-9]{64}$/.test(identity)
  )
    return Response.json({ code: 'invalid_identity' }, { status: 401 });
  const proof = { credential, identity };
  try {
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    if (operation === 'policy' && request.method === 'POST')
      return await stub.getAwsEgressPolicy(proof);
    if (operation === 'audit' && request.method === 'POST') {
      const value: unknown = JSON.parse(await readAwsResponse(new Response(request.body), 4096));
      return await stub.recordAwsEgressAudit(proof, value);
    }
    if (operation === 'scm') {
      const target = request.headers.get(AWS_EGRESS_TARGET_HEADER);
      if (!target || target.length > 16_384)
        return Response.json({ code: 'invalid_target' }, { status: 400 });
      const headers = cleanEgressHeaders(request.headers);
      const admission = await stub.admitAwsScm(proof, {
        target: { url: target, method: request.method },
        authorization: {
          ...(headers.has('authorization')
            ? { authorization: headers.get('authorization') ?? '' }
            : {}),
          ...(headers.has('private-token')
            ? { privateToken: headers.get('private-token') ?? '' }
            : {}),
        },
      });
      if (!admission.ok) {
        logger
          .withFields({ sandboxId, code: admission.code, status: admission.status })
          .warn('AWS SCM egress admission rejected');
        return Response.json(
          { code: admission.code },
          {
            status: admission.status,
            ...(admission.retryAfter
              ? { headers: { 'Retry-After': String(admission.retryAfter) } }
              : {}),
          }
        );
      }
      headers.set('host', new URL(target).host);
      const upstream = new Request(target, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        signal: request.signal,
      });
      // Body streams stay in this route. Never replay a write after an ambiguous forward.
      if (admission.authority.type === 'unmanaged') return await fetch(upstream);
      return await forwardResolvedScmCapability(
        upstream,
        env.GIT_TOKEN_SERVICE,
        { provider: admission.authority.provider, capability: admission.authority.capability },
        admission.authority.outboundContainerId
      );
    }
    return new Response(null, { status: 405 });
  } catch (error) {
    // Error messages can carry the target URL; log only the error class.
    logger
      .withFields({
        sandboxId,
        operation,
        errorName: error instanceof Error ? error.name : 'unknown',
      })
      .warn('AWS egress request failed');
    return Response.json({ code: 'egress_unavailable' }, { status: 503 });
  }
}
export function registerAwsEgressRoutes(app: Hono<HonoContext>): void {
  app.all('/aws-egress/:sandboxId/:operation', context =>
    handleAwsEgress(
      context.req.raw,
      context.env,
      context.req.param('sandboxId') ?? '',
      context.req.param('operation') ?? ''
    )
  );
}
