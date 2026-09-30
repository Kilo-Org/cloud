import { z } from 'zod';
import type { SessionAttachPayload } from '../../shared/sandbox-control-protocol.js';
import {
  controlPlanePromptPayloadSchema,
  type ControlPlaneCredentialSource,
  type ControlPlaneRouteSpec,
} from '../../shared/control-plane-protocol.js';
import {
  controlPlaneSandboxSelectionSchema,
  type ControlPlaneSandboxSelection,
} from './sandbox-selection.js';
import { credentialSourceFromMetadata } from '../../sandbox-control/session-credentials.js';
import { buildSessionAttachPayload } from '../../sandbox-session/attach-payload.js';
import {
  CurrentSessionMetadataSchema,
  type SessionMetadata,
} from '../../persistence/session-metadata.js';
import { hasModernRuntimeAuthorization } from '../../session/runtime-authorization-persistence.js';
import type { ControlPlaneSessionRegistration } from './session-do.js';

/**
 * Worker-facing creation input (spec §5, plan B4). The Worker owns sandbox
 * selection (H2): metadata carries the already-chosen `workspace.sandboxId` and
 * `sandboxSelection` carries the provider pin. The Worker also materializes the
 * canonical initial prompt payload, so it is not rebuilt from metadata.
 */
export const controlPlaneSessionCreateInputSchema = z
  .object({
    metadata: CurrentSessionMetadataSchema,
    message: controlPlanePromptPayloadSchema,
    sandboxSelection: controlPlaneSandboxSelectionSchema,
    runtimeAuthorizationSeal: z
      .string()
      .min(1)
      .max(64 * 1024)
      .optional(),
  })
  .strict();
export type ControlPlaneSessionCreateInput = z.infer<typeof controlPlaneSessionCreateInputSchema>;

/** Sibling registration input (H3): same grouped data, no initial turn. */
export const controlPlaneSessionRegisterInputSchema = z
  .object({
    metadata: CurrentSessionMetadataSchema,
    sandboxSelection: controlPlaneSandboxSelectionSchema,
    runtimeAuthorizationSeal: z
      .string()
      .min(1)
      .max(64 * 1024)
      .optional(),
  })
  .strict();
export type ControlPlaneSessionRegisterInput = z.infer<
  typeof controlPlaneSessionRegisterInputSchema
>;

/**
 * The metadata-derived attach payload sets `KILOCODE_TOKEN` to the native user
 * token. The Sandbox DO's grant issuance replaces it with the credential alias,
 * so the raw token must never appear in the route spec (B4 review, Low).
 */
function withoutRawKiloToken(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const { KILOCODE_TOKEN: _rawKiloToken, ...rest } = env;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * Adapts the metadata-derived attach payload to the new route-spec protocol
 * (plan Contracts). No capability rewrites: `adaptSessionAttachPayloadForWrapper`
 * is deliberately not applied. Token-bearing `git.token` is dropped — the
 * Sandbox DO's grant issuance supplies the `git`/`kilo` aliases in the projected
 * spec (B3 N3).
 */
export function controlPlaneRouteSpecFromAttachPayload(
  payload: SessionAttachPayload,
  ids: { sessionId: string; kiloSessionId: string },
  options?: { runtimeIsolation?: 'per-session' }
): ControlPlaneRouteSpec {
  if (payload.directory === undefined)
    throw new Error('Session attach payload requires a directory');
  const git =
    payload.git === undefined
      ? undefined
      : {
          url: payload.git.url,
          ...(payload.git.platform ? { platform: payload.git.platform } : {}),
        };
  const env = withoutRawKiloToken(payload.env);
  return {
    sessionId: ids.sessionId,
    kiloSessionId: ids.kiloSessionId,
    directory: payload.directory,
    ...(payload.branch ? { branch: payload.branch } : {}),
    ...(payload.branchMode ? { branchMode: payload.branchMode } : {}),
    ...(git ? { git } : {}),
    ...(env ? { env } : {}),
    ...(payload.setupCommands ? { setupCommands: payload.setupCommands } : {}),
    ...(options?.runtimeIsolation ? { runtimeIsolation: options.runtimeIsolation } : {}),
    // The Sandbox DO replaces this with its own route attempt id; the field is
    // only a protocol placeholder until an attempt starts.
    attemptId: `${ids.sessionId}-requested`,
  };
}

/**
 * Builds the DO registration from grouped metadata and the Worker's selection.
 * One owner: the DO records the given selection rather than re-deriving it (H2).
 * `runtimeIsolation` follows modern runtime authorization (M1).
 */
export function buildControlPlaneSessionRegistration(
  metadata: SessionMetadata,
  sandboxSelection: ControlPlaneSandboxSelection
): ControlPlaneSessionRegistration {
  const kiloSessionId = metadata.auth.kiloSessionId;
  if (kiloSessionId === undefined || kiloSessionId.length === 0) {
    throw new Error('Session metadata requires a kiloSessionId');
  }
  const sandboxId = metadata.workspace?.sandboxId;
  if (sandboxId === undefined || sandboxId.length === 0) {
    throw new Error('Session metadata requires a sandboxId');
  }
  // N2: one owner for the provider. Metadata is authoritative; the selection
  // must agree with it, and its configuration/billing must agree with the
  // selection, so no field can silently contradict another.
  const sandboxProvider = metadata.workspace?.sandboxProvider;
  if (sandboxProvider === undefined) {
    throw new Error('Session metadata requires a sandboxProvider');
  }
  if (sandboxSelection.provider !== sandboxProvider) {
    throw new Error('Sandbox selection provider does not match session metadata');
  }
  if (
    sandboxSelection.configuration !== undefined &&
    sandboxSelection.configuration.provider !== sandboxSelection.provider
  ) {
    throw new Error('Sandbox selection configuration does not match its provider');
  }
  if (sandboxSelection.billing !== undefined && sandboxSelection.billing.sandboxId !== sandboxId) {
    throw new Error('Sandbox selection billing does not match the session sandbox');
  }
  const payload = buildSessionAttachPayload(metadata);
  const spec = controlPlaneRouteSpecFromAttachPayload(
    payload,
    { sessionId: metadata.identity.sessionId, kiloSessionId },
    hasModernRuntimeAuthorization(metadata) ? { runtimeIsolation: 'per-session' } : undefined
  );
  const credentials: ControlPlaneCredentialSource = {
    ...credentialSourceFromMetadata(metadata),
    scopeId: metadata.workspace?.worktreeId ?? metadata.identity.sessionId,
  };
  return { sandboxId, spec, credentials, sandboxSelection };
}
