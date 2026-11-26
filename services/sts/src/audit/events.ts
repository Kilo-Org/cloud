import {
  AuditEventSchema,
  OCSF_API_ACTIVITY,
  OCSF_CLASS,
  type AuditEvent,
  type SecretName,
  type StsEnvironment,
  type WorkloadName,
} from '@kilocode/sts-contracts';
import type { PolicySnapshotEntry } from '../policy/load';
import type { KeyRevocation, KeyRingChange } from '../tokens/key-ring';
import type { GithubRun } from '../identity/verify';
import type { BundleDenial, TokenDenial } from './denials';

/** Attributes hold at most 256 values; longer lists are cut and flagged. */
function attributeList(values: string[]): { values: string[]; truncated: boolean } {
  return { values: values.slice(0, 256), truncated: values.length > 256 };
}

export function stsSource(environment: StsEnvironment): string {
  return `kilo:sts:${environment}`;
}

export function bundleDeliveredEvent(input: {
  environment: StsEnvironment;
  workload: WorkloadName;
  etag: string;
  stale: boolean;
  secrets: { name: SecretName; version: number }[];
  missing: SecretName[];
  /** The GitHub run a CI caller's verified token names; per-run claims appear on no refusal row. */
  run: GithubRun | null;
}): AuditEvent {
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.bundle.delivered',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.read,
      outcome: 'success',
      actor: { kind: 'workload', id: input.workload },
      attributes: {
        workload: input.workload,
        environment: input.environment,
        etag: input.etag,
        stale: input.stale,
        secretCount: input.secrets.length,
        secrets: input.secrets.map(secret => `${secret.name}:${secret.version}`),
        missing: [...input.missing],
        ...(input.run === null
          ? {}
          : {
              jobWorkflowRef: input.run.jobWorkflowRef,
              runId: input.run.runId,
              ...(input.run.runAttempt === undefined ? {} : { runAttempt: input.run.runAttempt }),
            }),
      },
    },
  });
}

/**
 * `count` identical refused reads in the minute starting at `windowStart` (design 4.3: STS refuses
 * and audits any other read). `overflow` marks the row that counts denials past the per-minute
 * distinct limit; it carries no claims.
 */
export function bundleDeniedEvent(input: {
  environment: StsEnvironment;
  denial: BundleDenial;
  count: number;
  windowStart: string;
  overflow: boolean;
}): AuditEvent {
  const claims = Object.keys(input.denial.claims)
    .sort()
    .map(name => `${name}=${input.denial.claims[name]}`.slice(0, 256));
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.bundle.denied',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.read,
      outcome: 'denied',
      outcomeDetail: input.denial.reason,
      actor: {
        kind: input.denial.channel === 'worker-binding' ? 'workload' : 'service',
        id: input.denial.actor,
      },
      attributes: {
        environment: input.environment,
        channel: input.denial.channel,
        reason: input.denial.reason,
        count: input.count,
        windowStart: input.windowStart,
        overflow: input.overflow,
        claims,
      },
    },
  });
}

/**
 * The manager returned a value in secret-reference syntax. STS kept the last good copy of that
 * one secret (or none) and records the name and version only (design 4.2).
 */
export function managerReferenceRefusedEvent(input: {
  environment: StsEnvironment;
  path: string;
  name: string;
  version: number;
  keptLastGood: boolean;
}): AuditEvent {
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.manager.reference_refused',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.read,
      outcome: 'failure',
      outcomeDetail: 'secret value uses reference syntax',
      actor: { kind: 'system', id: `sts:${input.environment}` },
      attributes: {
        environment: input.environment,
        path: input.path.slice(0, 512),
        secret: input.name.slice(0, 512),
        version: input.version,
        keptLastGood: input.keptLastGood,
      },
    },
  });
}

/** `workload:<value>` for every value of one grant list, such as `o11y:O11Y_CF_AE_API_TOKEN`. */
function grantKeys(
  snapshot: PolicySnapshotEntry[],
  grant: 'secrets' | 'audiences' | 'scopes'
): Set<string> {
  return new Set(
    snapshot.flatMap(entry => entry[grant].map(value => `${entry.workload}:${value}`))
  );
}

/** What `current` adds to and removes from `previous`, cut to attribute size and flagged. */
function diff(
  previous: Set<string>,
  current: Set<string>
): { added: string[]; removed: string[]; truncated: boolean } {
  const added = attributeList([...current].filter(key => !previous.has(key)));
  const removed = attributeList([...previous].filter(key => !current.has(key)));
  return {
    added: added.values,
    removed: removed.values,
    truncated: added.truncated || removed.truncated,
  };
}

export function policyChangedEvent(input: {
  environment: StsEnvironment;
  policyHash: string;
  previousPolicyHash: string | null;
  previous: PolicySnapshotEntry[];
  current: PolicySnapshotEntry[];
}): AuditEvent {
  const workloads = diff(
    new Set(input.previous.map(entry => entry.workload)),
    new Set(input.current.map(entry => entry.workload))
  );
  const secrets = diff(grantKeys(input.previous, 'secrets'), grantKeys(input.current, 'secrets'));
  const audiences = diff(
    grantKeys(input.previous, 'audiences'),
    grantKeys(input.current, 'audiences')
  );
  const scopes = diff(grantKeys(input.previous, 'scopes'), grantKeys(input.current, 'scopes'));

  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.policy.changed',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.accountChange,
      activityId: OCSF_API_ACTIVITY.update,
      outcome: 'success',
      outcomeDetail: input.previousPolicyHash === null ? 'initial policy' : 'policy changed',
      actor: { kind: 'system', id: `sts:${input.environment}` },
      attributes: {
        environment: input.environment,
        policyHash: input.policyHash,
        previousPolicyHash: input.previousPolicyHash ?? 'none',
        addedWorkloads: workloads.added,
        removedWorkloads: workloads.removed,
        addedSecrets: secrets.added,
        removedSecrets: secrets.removed,
        addedAudiences: audiences.added,
        removedAudiences: audiences.removed,
        addedScopes: scopes.added,
        removedScopes: scopes.removed,
        workloadsTruncated: workloads.truncated,
        secretsTruncated: secrets.truncated,
        audiencesTruncated: audiences.truncated,
        scopesTruncated: scopes.truncated,
      },
    },
  });
}

/**
 * One mint call: every token it signed, as parallel `jtis`, `audiences` and `scopes` lists (design
 * 5.3: one audit row per call listing each token's `jti`, scope and audience). Never the token.
 */
export function tokenIssuedEvent(input: {
  environment: StsEnvironment;
  workload: WorkloadName;
  /** How the caller proved its identity: `worker-binding` or the OIDC provider. */
  identity: string;
  kid: string;
  issuedAt: number;
  expiresAt: number;
  attestationCapped: boolean;
  tokens: { jti: string; audience: string; scope: string }[];
}): AuditEvent {
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.token.issued',
    time: new Date(input.issuedAt * 1000).toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.create,
      outcome: 'success',
      actor: { kind: 'workload', id: input.workload },
      attributes: {
        workload: input.workload,
        environment: input.environment,
        identity: input.identity,
        kid: input.kid,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        lifetimeSeconds: input.expiresAt - input.issuedAt,
        attestationCapped: input.attestationCapped,
        tokenCount: input.tokens.length,
        jtis: input.tokens.map(token => token.jti),
        audiences: input.tokens.map(token => token.audience),
        scopes: input.tokens.map(token => token.scope),
      },
    },
  });
}

/**
 * `count` identical refused token requests in the minute starting at `windowStart`. A refusal of the
 * whole call (an identity that verified but maps to no usable policy) names no audience or scope.
 */
export function tokenDeniedEvent(input: {
  environment: StsEnvironment;
  denial: TokenDenial;
  count: number;
  windowStart: string;
  overflow: boolean;
}): AuditEvent {
  const { denial } = input;
  const claims = Object.keys(denial.claims)
    .sort()
    .map(name => `${name}=${denial.claims[name]}`.slice(0, 256));
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.token.denied',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.create,
      outcome: 'denied',
      outcomeDetail: denial.reason,
      actor: {
        kind: denial.channel === 'worker-binding' ? 'workload' : 'service',
        id: denial.actor,
      },
      attributes: {
        environment: input.environment,
        channel: denial.channel,
        reason: denial.reason,
        workload: denial.actor,
        ...(denial.audience === undefined ? {} : { audience: denial.audience }),
        ...(denial.scope === undefined ? {} : { scope: denial.scope }),
        count: input.count,
        windowStart: input.windowStart,
        overflow: input.overflow,
        claims,
      },
    },
  });
}

/**
 * A scheduled change to the token-signing key ring (design 5.7): the first key, the next key
 * published, the next key activated (the previous one retired), or a retired key unpublished.
 * API Activity, as for every token and secret operation (design 8.2); Account Change is for
 * policy and identity changes.
 */
export function tokenKeyRotatedEvent(input: {
  environment: StsEnvironment;
  change: KeyRingChange;
}): AuditEvent {
  const { change } = input;
  const detail: Record<string, string | number> = {};
  if (change.change === 'published')
    detail.activatesAt = new Date(change.activatesAt).toISOString();
  if (change.change === 'activated' && change.retiredKid !== null) {
    detail.retiredKid = change.retiredKid;
  }
  if (change.change === 'removed') detail.lastTokenExpiresAt = change.lastTokenExp;
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.token_key.rotated',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: change.change === 'removed' ? OCSF_API_ACTIVITY.delete : OCSF_API_ACTIVITY.update,
      outcome: 'success',
      outcomeDetail: change.change,
      actor: { kind: 'system', id: `sts:${input.environment}` },
      attributes: {
        environment: input.environment,
        change: change.change,
        kid: change.kid,
        ...detail,
      },
    },
  });
}

/**
 * A key left the ring in an emergency: it never signs again and leaves the key set. `cause` is
 * `listed` for a kid in `TOKEN_SIGNING_KIDS_REVOKED`, or `same_ring` for the `next` key of a shard
 * whose current key was listed (one storage leak exposes both). A dropped current or next key is
 * replaced by a freshly generated one at once.
 */
export function tokenKeyRevokedEvent(input: {
  environment: StsEnvironment;
  revocation: KeyRevocation;
}): AuditEvent {
  const { revocation } = input;
  return AuditEventSchema.parse({
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: stsSource(input.environment),
    type: 'ai.kilo.sts.token_key.revoked',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data: {
      classUid: OCSF_CLASS.apiActivity,
      activityId: OCSF_API_ACTIVITY.delete,
      outcome: 'success',
      outcomeDetail: 'emergency removal',
      actor: { kind: 'system', id: `sts:${input.environment}` },
      attributes: {
        environment: input.environment,
        kid: revocation.kid,
        state: revocation.state,
        cause: revocation.cause,
        replacementKid: revocation.replacementKid ?? 'none',
      },
    },
  });
}
