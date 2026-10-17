import {
  customRouterCandidateModel,
  customRouterEntryKey,
  type AutoRouter,
  type CustomRouterEntryRef,
  type CustomRouterScope,
} from '@kilocode/auto-routing-contracts';
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { CaseResultRow } from './db';
import { clientCaseResults, clientProfiles, type ClientProfileStatus } from './db-schema';
import { variantFromStorage, variantToStorage } from './reasoning-effort';
import { summarize } from './run';
import type { OfflineSweep } from './scoreboard/schema';

export type ClientProfileRow = typeof clientProfiles.$inferSelect;
export type ClientCaseResultRow = typeof clientCaseResults.$inferSelect;

export type ClientProfileOwner = { ownerType: CustomRouterScope; ownerId: string };

export type ClientProfileIdentity = ClientProfileOwner & {
  router: AutoRouter;
  entry: CustomRouterEntryRef;
  variant: string | null;
  engineIdentity: string;
  repetitions: number;
};

export const CLIENT_PROFILE_ALL_FAILED_REASON =
  'Every uploaded case failed or timed out; check the model in the CLI and run the eval again.';

const ID_BATCH_SIZE = 90;

export function clientPairKey(entry: CustomRouterEntryRef, variant: string | null): string {
  return JSON.stringify([customRouterEntryKey(entry), variant]);
}

export function clientProfileEntry(
  row: Pick<ClientProfileRow, 'entry_kind' | 'provider' | 'model'>
): CustomRouterEntryRef {
  return row.entry_kind === 'client'
    ? { kind: 'client', provider: row.provider, model: row.model }
    : { kind: 'gateway', model: row.model };
}

export function clientProfilePairKey(row: ClientProfileRow): string {
  return clientPairKey(clientProfileEntry(row), variantFromStorage(row.variant));
}

export function isCurrentClientProfile(
  row: Pick<ClientProfileRow, 'engine_identity' | 'repetitions'>,
  current: { engineIdentity: string; repetitions: number }
): boolean {
  return row.engine_identity === current.engineIdentity && row.repetitions === current.repetitions;
}

function identityColumns(identity: ClientProfileIdentity) {
  return {
    owner_type: identity.ownerType,
    owner_id: identity.ownerId,
    router: identity.router,
    entry_kind: identity.entry.kind,
    provider: identity.entry.kind === 'client' ? identity.entry.provider : '',
    model: identity.entry.model,
    variant: variantToStorage(identity.variant),
    engine_identity: identity.engineIdentity,
    repetitions: identity.repetitions,
  };
}

export async function listOwnerClientProfiles(
  db: D1Database,
  owner: ClientProfileOwner,
  router: AutoRouter
): Promise<ClientProfileRow[]> {
  return drizzle(db)
    .select()
    .from(clientProfiles)
    .where(
      and(
        eq(clientProfiles.owner_type, owner.ownerType),
        eq(clientProfiles.owner_id, owner.ownerId),
        eq(clientProfiles.router, router)
      )
    );
}

export function groupClientProfilesByPair(
  rows: readonly ClientProfileRow[]
): Map<string, ClientProfileRow[]> {
  const byPair = new Map<string, ClientProfileRow[]>();
  for (const row of rows) {
    const key = clientProfilePairKey(row);
    const list = byPair.get(key);
    if (list) list.push(row);
    else byPair.set(key, [row]);
  }
  return byPair;
}

export async function ensureClientProfile(
  db: D1Database,
  identity: ClientProfileIdentity,
  nowIso: string
): Promise<ClientProfileRow> {
  const orm = drizzle(db);
  const columns = identityColumns(identity);
  await orm
    .insert(clientProfiles)
    .values({
      id: crypto.randomUUID(),
      ...columns,
      status: 'pending',
      created_at: nowIso,
      updated_at: nowIso,
    })
    .onConflictDoNothing();
  const [row] = await orm
    .select()
    .from(clientProfiles)
    .where(
      and(
        eq(clientProfiles.owner_type, columns.owner_type),
        eq(clientProfiles.owner_id, columns.owner_id),
        eq(clientProfiles.router, columns.router),
        eq(clientProfiles.entry_kind, columns.entry_kind),
        eq(clientProfiles.provider, columns.provider),
        eq(clientProfiles.model, columns.model),
        eq(clientProfiles.variant, columns.variant),
        eq(clientProfiles.engine_identity, columns.engine_identity),
        eq(clientProfiles.repetitions, columns.repetitions)
      )
    );
  if (!row) throw new Error('client profile was not persisted');
  return row;
}

// A case ran when the CLI exited 0 without a timeout, the platform's reuse rule. Other
// stored cases are re-planned and an upload replaces them, so an endpoint that was down
// once does not keep its pair failed until the next engine version.
const ranSuccessfully = sql`(${clientCaseResults.exit_code} IS NOT NULL AND ${clientCaseResults.exit_code} = 0 AND ${clientCaseResults.timed_out} = 0)`;

export async function getClientCase(
  db: D1Database,
  key: { profileId: string; caseId: string; rep: number }
): Promise<{ score: number; ran: boolean } | null> {
  const [row] = await drizzle(db)
    .select({
      score: clientCaseResults.score,
      exitCode: clientCaseResults.exit_code,
      timedOut: clientCaseResults.timed_out,
    })
    .from(clientCaseResults)
    .where(
      and(
        eq(clientCaseResults.profile_id, key.profileId),
        eq(clientCaseResults.case_id, key.caseId),
        eq(clientCaseResults.rep, key.rep)
      )
    );
  return row ? { score: row.score, ran: row.exitCode === 0 && !row.timedOut } : null;
}

/**
 * Store an upload, replacing a stored case that did not run. Returns false when a
 * case that ran is already stored, for example by a concurrent upload.
 */
export async function saveClientCaseResult(
  db: D1Database,
  row: ClientCaseResultRow
): Promise<boolean> {
  const result = await drizzle(db)
    .insert(clientCaseResults)
    .values(row)
    .onConflictDoUpdate({
      target: [clientCaseResults.profile_id, clientCaseResults.case_id, clientCaseResults.rep],
      set: {
        route_key: row.route_key,
        output: row.output,
        cost_usd: row.cost_usd,
        duration_ms: row.duration_ms,
        exit_code: row.exit_code,
        timed_out: row.timed_out,
        score: row.score,
        grader_cost_usd: row.grader_cost_usd,
        uploaded_at: row.uploaded_at,
      },
      setWhere: not(ranSuccessfully),
    });
  return (result.meta.changes ?? 0) > 0;
}

/** Remove one upload, matched by its upload time, after its grading could not be billed. */
export async function deleteClientCaseUpload(
  db: D1Database,
  key: { profileId: string; caseId: string; rep: number; uploadedAt: string }
): Promise<void> {
  await drizzle(db)
    .delete(clientCaseResults)
    .where(
      and(
        eq(clientCaseResults.profile_id, key.profileId),
        eq(clientCaseResults.case_id, key.caseId),
        eq(clientCaseResults.rep, key.rep),
        eq(clientCaseResults.uploaded_at, key.uploadedAt)
      )
    );
}

/** `${caseId}\0${rep}` keys of cases that ran, per profile id. */
export async function listClientCaseKeys(
  db: D1Database,
  profileIds: readonly string[]
): Promise<Map<string, Set<string>>> {
  const keys = new Map<string, Set<string>>();
  const orm = drizzle(db);
  for (let offset = 0; offset < profileIds.length; offset += ID_BATCH_SIZE) {
    const rows = await orm
      .select({
        profileId: clientCaseResults.profile_id,
        caseId: clientCaseResults.case_id,
        rep: clientCaseResults.rep,
      })
      .from(clientCaseResults)
      .where(
        and(
          inArray(clientCaseResults.profile_id, profileIds.slice(offset, offset + ID_BATCH_SIZE)),
          ranSuccessfully
        )
      );
    for (const row of rows) {
      const set = keys.get(row.profileId) ?? new Set<string>();
      set.add(clientCaseKey(row.caseId, row.rep));
      keys.set(row.profileId, set);
    }
  }
  return keys;
}

export function clientCaseKey(caseId: string, rep: number): string {
  return `${caseId}\0${rep}`;
}

type GradedClientCase = Omit<ClientCaseResultRow, 'output'>;

async function listGradedClientCases(
  db: D1Database,
  profileIds: readonly string[]
): Promise<GradedClientCase[]> {
  const orm = drizzle(db);
  const rows: GradedClientCase[] = [];
  for (let offset = 0; offset < profileIds.length; offset += ID_BATCH_SIZE) {
    rows.push(
      ...(await orm
        .select({
          profile_id: clientCaseResults.profile_id,
          case_id: clientCaseResults.case_id,
          rep: clientCaseResults.rep,
          route_key: clientCaseResults.route_key,
          cost_usd: clientCaseResults.cost_usd,
          duration_ms: clientCaseResults.duration_ms,
          exit_code: clientCaseResults.exit_code,
          timed_out: clientCaseResults.timed_out,
          score: clientCaseResults.score,
          grader_cost_usd: clientCaseResults.grader_cost_usd,
          uploaded_at: clientCaseResults.uploaded_at,
        })
        .from(clientCaseResults)
        .where(
          inArray(clientCaseResults.profile_id, profileIds.slice(offset, offset + ID_BATCH_SIZE))
        ))
    );
  }
  return rows;
}

function caseError(row: Pick<GradedClientCase, 'exit_code' | 'timed_out'>): string | null {
  if (row.timed_out) return 'timed out';
  return row.exit_code === 0 ? null : `exit code ${row.exit_code ?? 'none'}`;
}

function asCaseResultRow(
  row: GradedClientCase,
  model: string,
  variant: string,
  routeKey: string | null
): CaseResultRow {
  return {
    run_id: row.profile_id,
    model,
    variant,
    case_id: row.case_id,
    route_key: routeKey,
    score: row.score,
    latency_ms: row.duration_ms,
    cost_usd: row.cost_usd,
    error: caseError(row),
    fallback_reason: null,
    route_hit: null,
    retried: null,
    exit_code: row.exit_code,
    output_prefix: null,
    event_count: null,
    last_event_types: null,
    rep: row.rep,
    timed_out: row.timed_out ? 1 : 0,
  };
}

export type ClientProfileRollup = Pick<
  ClientProfileRow,
  | 'status'
  | 'failure_reason'
  | 'results'
  | 'accuracy'
  | 'errors'
  | 'timeouts'
  | 'avg_cost_usd'
  | 'p50_latency_ms'
  | 'p95_latency_ms'
  | 'route_summaries'
>;

/**
 * Summaries use the platform's `summarize`, keyed by the candidate model string the
 * custom table emits. A profile serves as soon as one case ran without error; it fails
 * only once every planned case repetition was uploaded and none did.
 */
export function rollUpClientCases(
  profile: ClientProfileRow,
  rows: readonly GradedClientCase[],
  plannedResults: number
): ClientProfileRollup {
  const model = customRouterCandidateModel(clientProfileEntry(profile));
  const [overall] = summarize(
    rows.map(row => asCaseResultRow(row, model, profile.variant, null)),
    'decider'
  );
  const succeeded = rows.some(row => caseError(row) === null);
  const status: ClientProfileStatus = succeeded
    ? 'ready'
    : rows.length >= plannedResults
      ? 'failed'
      : 'pending';
  return {
    status,
    failure_reason: status === 'failed' ? CLIENT_PROFILE_ALL_FAILED_REASON : null,
    results: rows.length,
    accuracy: overall?.accuracy ?? null,
    errors: overall?.errors ?? 0,
    timeouts: overall?.timeouts ?? 0,
    avg_cost_usd: overall?.avgCostUsd ?? null,
    p50_latency_ms: overall?.p50LatencyMs ?? null,
    p95_latency_ms: overall?.p95LatencyMs ?? null,
    route_summaries: summarize(
      rows.map(row => asCaseResultRow(row, model, profile.variant, row.route_key)),
      'decider'
    ),
  };
}

/**
 * Recompute the profile summary from every stored case. Concurrent uploads each write
 * their own view; the guard keeps only a view computed from the cases stored at write
 * time, so a stale view never overwrites a newer one and a removed case lowers the count.
 */
export async function refreshClientProfileRollup(
  db: D1Database,
  profile: ClientProfileRow,
  plannedResults: number,
  nowIso: string
): Promise<void> {
  const rollup = rollUpClientCases(
    profile,
    await listGradedClientCases(db, [profile.id]),
    plannedResults
  );
  await drizzle(db)
    .update(clientProfiles)
    .set({ ...rollup, updated_at: nowIso })
    .where(
      and(
        eq(clientProfiles.id, profile.id),
        sql`(SELECT COUNT(*) FROM ${clientCaseResults} WHERE ${clientCaseResults.profile_id} = ${profile.id}) = ${rollup.results}`
      )
    );
}

export async function getClientRoutingCaseResults(
  db: D1Database,
  profiles: readonly ClientProfileRow[]
): Promise<OfflineSweep['pairs']> {
  const byId = new Map(profiles.map(profile => [profile.id, profile]));
  const pairs = new Map<string, OfflineSweep['pairs'][number]>();
  for (const row of await listGradedClientCases(db, [...byId.keys()])) {
    const profile = byId.get(row.profile_id);
    if (!profile) continue;
    let pair = pairs.get(profile.id);
    if (!pair) {
      pair = {
        model: customRouterCandidateModel(clientProfileEntry(profile)),
        variant: variantFromStorage(profile.variant),
        results: [],
      };
      pairs.set(profile.id, pair);
    }
    pair.results.push({
      caseId: row.case_id,
      routeKey: row.route_key,
      rep: row.rep,
      score: row.score,
      costUsd: row.cost_usd,
      latencyMs: row.duration_ms,
      error: caseError(row),
      graderCostUsd: 0,
      split: 'train',
    });
  }
  return [...pairs.values()];
}
