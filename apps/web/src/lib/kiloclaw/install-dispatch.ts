import 'server-only';
import { TRPCError } from '@trpc/server';
import { fetchInstallPayload } from './install';
import type { InstallSource } from './install-sources';
import { requireKiloClawAccessAtInstance } from './access-gate';
import {
  getActiveInstance,
  workerInstanceId,
  type ActiveKiloClawInstance,
} from './instance-registry';
import { KiloClawInternalClient } from './kiloclaw-internal-client';
import { postMessageAsUser } from './kilo-chat-internal-client';

/**
 * Server-side dispatch for the `installFromSource` tRPC mutation, extracted
 * here so the decision logic is unit-testable without a full tRPC + DB
 * setup. The mutation is a thin wrapper that supplies `userId` from
 * `ctx.user.id`.
 *
 * Outcomes:
 * - `{ ok: true, ... }` — payload verified, message dispatched to the user's
 *   kiloclaw chat as their own user-turn. Client redirects to `/claw/chat`.
 * - `{ ok: false, code: 'no_instance' }` — caller has no active kiloclaw
 *   instance yet. Client redirects to `/claw/new` to provision; the install
 *   intent is not persisted across that flow (the user re-installs from the
 *   byte page once set up).
 *
 * Other failure modes throw a `TRPCError`:
 * - `NOT_FOUND` — byte missing upstream, signature failed, slug mismatch,
 *   or verification config broken. Already logged in detail by
 *   `fetchInstallPayload`; the throw is a one-liner for the client.
 * - `INTERNAL_SERVER_ERROR` — kilo-chat returned `forbidden` (internal-auth
 *   misconfigured) or `internal` (network/timeout/unknown). These should
 *   page on-call; client gets a generic error.
 */

export type DispatchInstallFromSourceArgs = {
  userId: string;
  source: InstallSource;
  slug: string;
  // The Ed25519 signature of the payload the user actually reviewed on the
  // confirmation page. We re-fetch + re-verify server-side, then require the
  // re-fetched payload's signature to match this, so a byte edited+re-signed
  // between preview and confirm can't dispatch a different (still-valid)
  // prompt than the one the user approved.
  expectedSignature: string;
};

export type DispatchInstallFromSourceResult =
  | {
      ok: true;
      conversationId: string;
      messageId: string;
      conversationCreated: boolean;
    }
  | { ok: false; code: 'no_instance' };

// Dependency injection points kept narrow for testing. Real callers always
// use the production implementations.
export type DispatchInstallFromSourceDeps = {
  fetchInstallPayload: typeof fetchInstallPayload;
  getActiveInstance: typeof getActiveInstance;
  resolveRuntimeSandboxId: (
    userId: string,
    instance: ActiveKiloClawInstance
  ) => Promise<string | null>;
  requireKiloClawAccessAtInstance: typeof requireKiloClawAccessAtInstance;
  postMessageAsUser: typeof postMessageAsUser;
};

/**
 * Resolve the *runtime* sandbox id the chat is currently keyed on, not the
 * Postgres registry row's `sandbox_id`. Matches the dashboard/status path
 * (`client.getStatus(userId, workerInstanceId(instance)).sandboxId`).
 *
 * Why this matters: during half-migrated states the registry row may still
 * carry a legacy sandbox id while the active worker / chat are on
 * `ki_<instanceId>`. Dispatching against the registry value in that state
 * would write the install message into a stale conversation that the user
 * never sees.
 */
async function defaultResolveRuntimeSandboxId(
  userId: string,
  instance: ActiveKiloClawInstance
): Promise<string | null> {
  const client = new KiloClawInternalClient();
  const status = await client.getStatus(userId, workerInstanceId(instance));
  return status.sandboxId ?? null;
}

const defaultDeps: DispatchInstallFromSourceDeps = {
  fetchInstallPayload,
  getActiveInstance,
  resolveRuntimeSandboxId: defaultResolveRuntimeSandboxId,
  requireKiloClawAccessAtInstance,
  postMessageAsUser,
};

export async function dispatchInstallFromSource(
  args: DispatchInstallFromSourceArgs,
  deps: DispatchInstallFromSourceDeps = defaultDeps
): Promise<DispatchInstallFromSourceResult> {
  const { userId, source, slug, expectedSignature } = args;

  // Uncached read: this is the confirm-time dispatch, so a byte changed,
  // revoked, or deleted since the preview rendered must be seen now (a stale
  // cached payload would still match the reviewed signature and dispatch).
  const payload = await deps.fetchInstallPayload(source, slug, { bypassCache: true });
  if (!payload) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'This install link is not available.',
    });
  }

  // Bind the dispatch to exactly what the user reviewed. The signature is the
  // cryptographic identity of the signed content (slug/title/description/
  // prompt); if it no longer matches, the byte changed since the confirmation
  // page rendered, so refuse rather than run a prompt the user didn't approve.
  if (payload.signature !== expectedSignature) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This byte changed since you reviewed it. Please reload and confirm again.',
    });
  }

  const instance = await deps.getActiveInstance(userId);
  if (!instance) {
    // Don't dispatch yet — the user has no instance to deliver into. The
    // client redirects them to `/claw/new` to provision; they re-install
    // from the byte page afterward (intent is intentionally not persisted).
    return { ok: false, code: 'no_instance' };
  }

  // Bind entitlement to THIS exact instance. The `clawAccessProcedure` gate
  // only proves the user has some active access; in an inconsistent billing
  // state (e.g. the current subscription anchored to a different/destroyed row
  // while an orphaned active instance remains) that gate can pass while the
  // resolved instance is not entitled. Re-check access for the resolved
  // instance and fail closed, so a prompt is never dispatched into an
  // unentitled runtime. Throws TRPCError FORBIDDEN/NOT_FOUND on mismatch.
  await deps.requireKiloClawAccessAtInstance(userId, instance.id);

  // Use the runtime sandbox id (not the registry row's `sandboxId`) so
  // half-migrated rows don't dispatch into a stale conversation. See
  // `defaultResolveRuntimeSandboxId` for the why.
  const runtimeSandboxId = await deps.resolveRuntimeSandboxId(userId, instance);
  if (!runtimeSandboxId) {
    // Instance row exists but the runtime isn't reporting a sandbox yet —
    // provisioning still in flight. Same UX class as no-instance, so the
    // client lands on /claw/new and re-tries once chat is ready.
    return { ok: false, code: 'no_instance' };
  }

  const dispatchedAt = new Date().toISOString();
  // Correlation.reason is capped at 200 chars in the shared schema. Install
  // slugs are accepted up to 200, so `clawbyte:${slug}` can exceed 200 and
  // get rejected as invalid_request. Truncate the audit field rather than
  // bouncing an otherwise-valid install; the slug also appears verbatim in
  // the install_dispatched log line below.
  const reason = `clawbyte:${slug}`.slice(0, 200);
  const result = await deps.postMessageAsUser({
    userId,
    sandboxId: runtimeSandboxId,
    message: payload.prompt,
    source: 'install',
    // Each install gets its own dedicated conversation rather than appending
    // to whatever the user last chatted in. (`forceNewConversation` already
    // implies creation, so `autoCreateConversation` is omitted as redundant.)
    forceNewConversation: true,
    correlation: { reason },
  });

  if (result.ok) {
    // Audit log — durable storage is a separate open question; log-only
    // for v1 so on-call can grep by these fields. The shape is intentionally
    // flat-keyed JSON-stringified so it survives structured-log shipping.
    console.info(
      JSON.stringify({
        event: 'install_dispatched',
        userId,
        source,
        slug,
        signatureKeyId: payload.signatureKeyId,
        signedAt: payload.signedAt,
        dispatchedAt,
        conversationId: result.conversationId,
        messageId: result.messageId,
        conversationCreated: result.conversationCreated,
      })
    );
    return {
      ok: true,
      conversationId: result.conversationId,
      messageId: result.messageId,
      conversationCreated: result.conversationCreated,
    };
  }

  // result.ok === false: log loudly and throw. Each code is operationally
  // distinct (auth bug vs. transient infra) so the log line carries enough
  // to grep on.
  console.error(
    JSON.stringify({
      event: 'install_dispatch_failed',
      userId,
      source,
      slug,
      signatureKeyId: payload.signatureKeyId,
      kilochatCode: result.code,
      kilochatError: result.error,
    })
  );

  // `no_conversation` from kilo-chat would mean the instance exists but
  // its chat hasn't been provisioned yet — same UX class as the
  // no_instance case above, so map it to the typed result for consistency.
  if (result.code === 'no_conversation') {
    return { ok: false, code: 'no_instance' };
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Could not install this byte. Please try again.',
  });
}
