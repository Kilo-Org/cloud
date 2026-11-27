#!/usr/bin/env node
// Driver for one matrix entry of the temporary runtime copier (M122; M84 properties per Worker).
// It runs only inside .github/workflows/runtime-copy.yml, one source Worker per job, the jobs one
// at a time. The workflow passes only the Worker name (a Worker of the reviewed row table,
// src/table.mjs) and its matrix index; everything else is fixed here or in the core
// (scripts/secrets-migration/runtime-copy/). `--plan` (the workflow's first job, no secrets, no
// GitHub API call) validates the whole table and every Worker's sources offline and prints the
// matrix.
//
// Order. Each step stops on its first failure; cleanup always runs for the attributable new script.
//   1. Context guards: repository, ref, event, exact commit, credentials present. The writer secret
//      and the operator readback are taken out of process.env, so no child process inherits them.
//      The operator readback must be compact JSON (one line, so the runner masks it as one value),
//      bound to this commit, batch, source and targets, and fresh.
//   2. Window: the earliest minute tick at least the propagation lead ahead whose 15-minute window
//      the one-use writer client secret's expiry fits (core preflight bound: notAfter <= expiresAt
//      <= notAfter + 15 min, with one minute of margin). The earliest tick keeps the run short.
//      A writer secret that expires more than 60 minutes after start is refused.
//      Then the core's validated name table, printed once; a refusal stops before any network call.
//   3. GitHub guard: no Worker rollout workflow is queued or running. A rollout workflow that
//      cannot be read stops the run. The copy uses its own concurrency group, so it never displaces
//      a pending rollout. The protected environment is not read here: the job token cannot read it.
//      GitHub enforces its required reviewers, self-review prevention and branch policy before this
//      job starts, and the operator reads every environment back with admin rights before dispatch.
//   4. Names-only snapshot of every existing Worker's current deployment (versions and percentages).
//      The copier script must be absent.
//   5. Render (core render-config.mjs), then `wrangler deploy` UNARMED: no writer secret. The
//      serving version is attributed to this run only by its provider version id, this run's
//      unique pins in its own bindings and the tracked module hashes; nothing else is recorded.
//   6. Tail until the unarmed receipt for that version shows every readiness flag. That is the
//      observed cron propagation and proves the tail observer. Hold if it misses the arm deadline.
//   7. Full core preflight on the serving UNARMED copier: source serving version and its bindings
//      (read from the version itself), store, copier version bindings, raw settings, modules,
//      triggers, the unarmed receipt, and the operator's Infisical, reader and writer readback.
//      Any failure stops here and deletes the closed copier. No secret has been written.
//   8. Final guard: no rollout queued or running, every deployment unchanged, the copier still
//      serves exactly the unarmed version, and the arm deadline has not passed. No bypass.
//   9. Arm: `wrangler secret put` reads the writer secret from stdin, bounded by the put deadline.
//      Readback: a new version at 100% whose bindings are the verified unarmed bindings plus
//      exactly the writer `secret_text` (core `bindArmedPreflight`), and the tracked modules.
//      A failed or timed-out put is unproved: stop, clean up only attributable objects, and
//      require operator reconciliation. Never retried. For cleanup only, a post-put version that
//      fails that readback but carries this run's unique pins and the tracked modules is still
//      this run's to delete; it never counts as armed and never pins the post-run gate.
//  10. Same tail: the armed version's idle `outside_window` receipt before not-before, else delete.
//  11. Same tail: the final receipt. Cloudflare post-run gate against the armed pins. There is no
//      second preflight and no acceptance after a failed gate.
//  12. Cleanup, before the tail is stopped: delete the copier only if every version it serves was
//      attributed by this run (never forced, never retried). Prove it and its gate namespace gone,
//      then prove every other Worker's deployment unchanged. Only on drift, list the rollout
//      workflow runs created during the run (names, ids, timestamps); an unreadable list is
//      reported and never changes the verdict. Drift after a passing final receipt fails the
//      report, not the copy: the value is already in Infisical.
//  13. Stop the tail: SIGINT, then SIGKILL, each bounded.
//
// SIGINT and SIGTERM (job cancel or timeout) stop further phases, unblock any wait and stop a
// running child within about one second. A signal during `secret put` still runs the arm readback,
// each read once with the short abort timeout, so a landed put can be attributed. Then cleanup
// runs one read and one delete, each once with the short timeout (no retry, no status read, no
// namespace read, snapshot or rollout listing), and the tail is stopped. GitHub follows with
// SIGKILL a few seconds later, so cancel and timeout can still act like SIGKILL: cleanup may not
// finish.
// After any run that does not end with a passing cleanup gate, the operator revokes the writer
// and reads the copier back privately before anything else; `operatorAction` reads
// `REVOKE THE WRITER NOW` while not-before has not passed.
//
// STS deploy token (CLOUDFLARE_TOKEN_SOURCE `sts`): CLOUDFLARE_TOKEN_EXPIRES_AT is the mint step's
// `expires_at` output. The run refuses at start unless the token outlives the result deadline by
// 8 minutes, and 7 minutes before it expires it stops admitting phases, caps every wait and child
// there and goes to the normal cleanup (`token_expiry_abort`) while the token can still delete.
// The token lives at most 60 minutes from the mint, so cleanup starts by minute 53.
//
// Cleanup has its own deadline: the earlier of the step limit (`stepLimitMs`, from driver start)
// and the token expiry, minus `cleanupSlackMs`. Every cleanup read is capped there; past it only
// the copier read and delete run, once each with the short timeout. A deployment snapshot that the
// deadline cuts off records `drift: 'not_read_by_deadline'`, the report is still printed, and the
// entry fails as `token_expiry_abort`.
//
// CI proves only the Cloudflare half. The operator completes the Infisical post-run and cleanup
// gates privately with this report's `preflightPins` and `finalReceipt` and its own readback.
//
// Output: names, ids, timestamps, counts, booleans, and the digest of the rendered config (which
// holds no secret). No secret value or value digest, token, principal or raw log line is printed,
// written or passed in argv.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MODULES,
  WORKER_SOURCES,
  bindArmedPreflight,
  evaluateCleanupCloudflare,
  evaluatePostRunCloudflare,
  evaluatePreflight,
  moduleHashes,
  parseReceipt,
  sharedBinders,
  validatedNameTable,
} from './runtime-copy/checks.mjs';
import {
  ACCOUNT_ID,
  OUTCOMES,
  RUN_VARS,
  WRITER_SECRET,
  copierName,
} from './runtime-copy/src/core.mjs';
import { TABLE } from './runtime-copy/src/table.mjs';

export const REPOSITORY = 'Kilo-Org/cloud';
export const REF = 'refs/heads/main';
export const OPERATOR_META = 'M65_OPERATOR_PREFLIGHT';
export const OPERATOR_SCHEMA = 'runtime-copy-preflight/1';
export const CF_API = 'https://api.cloudflare.com/client/v4';
/** The protected GitHub environment of one source Worker's matrix entry. */
export const environmentName = worker => `runtime-copy-${worker}`;
/** Workflows that deploy Workers into this account; none may be queued or running beside the copy. */
export const ROLLOUT_WORKFLOWS = Object.freeze([
  'deploy-production.yml',
  'deploy-staging.yml',
  // Counts only its direct workflow_dispatch runs: its workflow_call runs are listed under the
  // calling deploy-production/deploy-staging run, which is already guarded above.
  'deploy-workers.yml',
  'cloud-agent-e2e-deploy.yml',
]);
const ACTIVE_RUN_STATUSES = Object.freeze([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);
export const TIMING = Object.freeze({
  leadMs: 24 * 60_000,
  // Credential custody: the writer client secret expires at most this long after the run starts.
  maxExpiryAheadMs: 60 * 60_000,
  operatorMaxAgeMs: 30 * 60_000,
  windowMs: 15 * 60_000,
  // Core preflight: the writer client secret expires at most this long after not-after.
  writerGraceMs: 15 * 60_000,
  armBudgetMs: 6 * 60_000,
  putMarginMs: 2 * 60_000,
  readyMarginMs: 60_000,
  resultGraceMs: 3 * 60_000,
  cfTimeoutMs: 15_000,
  readRetryMs: 2_000,
  processTimeoutMs: 5 * 60_000,
  killGraceMs: 5_000,
  // After a stop signal: GitHub sends SIGINT, then SIGTERM, then SIGKILL within seconds, so each
  // child gets about one second before SIGKILL.
  abortGraceMs: 1_000,
  // After a stop signal each Cloudflare read or delete gets this long, once, with no retry.
  abortCallTimeoutMs: 2_500,
  // STS path: refuse to start unless the token outlives the result deadline by this much, and
  // stop admitting phases this long before it expires, so cleanup starts while the token is still
  // live: by minute 53 of a 60-minute token.
  tokenStartMarginMs: 8 * 60_000,
  tokenAbortMarginMs: 7 * 60_000,
  // The driver step's limit, from driver start: the STS step's `timeout-minutes: 58`; on the
  // stored-token path the job's 80 minutes minus up to 5 for the steps before the driver.
  stepLimitMs: Object.freeze({ sts: 58 * 60_000, secret: 75 * 60_000 }),
  // Cleanup stops reading this long before the step limit or the token expiry.
  cleanupSlackMs: 60_000,
  rolloutRunsPerWorkflow: 20,
});

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
// The pinned Wrangler from one Worker closure (the workflow installs it); the copier needs no
// code of any source Worker.
export const WRANGLER_BIN = join(REPO_ROOT, 'services/notifications/node_modules/.bin/wrangler');
export const RENDER_CONFIG = join(HERE, 'runtime-copy/render-config.mjs');

/**
 * Everything one matrix entry acts on, from the valid table only: the Worker's reviewed batch, its
 * copier script, its protected environment and its Infisical targets. Null for anything else.
 * `table` is the checked-in table; tests pass a fixture table.
 */
export function targetOf(worker, table = TABLE) {
  if (table.problems.length > 0 || !Object.hasOwn(table.batches, String(worker))) return null;
  const batch = table.batches[worker];
  return Object.freeze({
    worker,
    batch,
    source: batch.sourceScript,
    copier: copierName(worker),
    environment: environmentName(worker),
    targets: Object.freeze(batch.rows.map(r => `${r.secretPath}/${r.secretKey}`)),
  });
}

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MINUTE = 60_000;

export class StopError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Dispatch identity: repository, ref, event, the exact approved commit and the checkout. */
export function dispatchProblems(env, headSha) {
  const p = [];
  if (env.GITHUB_REPOSITORY !== REPOSITORY) p.push('repository');
  if (env.GITHUB_REF !== REF) p.push('ref');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') p.push('event');
  if (!SHA.test(env.GITHUB_SHA ?? '')) p.push('sha');
  else if (env.EXPECTED_COMMIT !== env.GITHUB_SHA) p.push('expected_commit');
  else if (headSha !== env.GITHUB_SHA) p.push('checkout_head');
  if (!/^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? '')) p.push('run_id');
  if (!/^[0-9]{1,4}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) p.push('run_attempt');
  return p;
}

/** Names-only context problems for the copy job. Empty means the run may start. */
export function contextProblems(env, headSha, table = TABLE) {
  const p = dispatchProblems(env, headSha);
  // The rollout guard reads workflow runs with the job token.
  if (!env.GITHUB_TOKEN) p.push('github_token');
  if (!targetOf(env.COPY_WORKER, table)) p.push('worker');
  if (!/^[0-9]{1,3}$/.test(env.COPY_INDEX ?? '')) p.push('matrix_index');
  if (!['secret', 'sts'].includes(env.CLOUDFLARE_TOKEN_SOURCE)) p.push('token_source');
  else if (env.CLOUDFLARE_TOKEN_SOURCE === 'sts' && !Number.isFinite(tokenExpiryOf(env))) {
    p.push('token_expiry');
  }
  if (!isAbsolute(env.RUNNER_TEMP ?? '')) p.push('runner_temp');
  if (!env.CLOUDFLARE_API_TOKEN) p.push('cloudflare_token');
  if (!env[WRITER_SECRET]) p.push('writer_secret');
  if (!env[OPERATOR_META]) p.push('operator_meta');
  if (!UUID.test(env.M65_INFISICAL_CLIENT_ID ?? '')) p.push('client_id');
  return p;
}

/**
 * The STS deploy token's expiry (the mint step's `expires_at` output) in ms, or NaN. The stored
 * token has no known expiry; it is Infinity there.
 */
export function tokenExpiryOf(env) {
  if (env.CLOUDFLARE_TOKEN_SOURCE !== 'sts') return Infinity;
  const at = String(env.CLOUDFLARE_TOKEN_EXPIRES_AT ?? '');
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/.test(at) ? Date.parse(at) : NaN;
}

const isoSeconds = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o, keys) =>
  isRecord(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());

/**
 * Operator readback: the names-only Infisical metadata, the allowed readers and the writer's
 * issuer settings, read privately by the operator immediately before this entry is approved. It is
 * bound to this commit and this Worker's batch, source and targets, and it must be fresh. It must
 * be one line: the runner masks a multi-line secret line by line (actions/runner Worker.cs), which
 * would blank short lines such as `}` all over this job's log. CI never reads Infisical; the core
 * preflight judges the content. Returns `{operator}` or `{problem}`.
 */
export function parseOperatorMeta(text, env, nowMs, target) {
  if (/[\r\n]/.test(String(text))) return { problem: 'operator_meta_not_compact' };
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { problem: 'operator_meta_unparsable' };
  }
  const keys = [
    'schema',
    'batch',
    'commit',
    'sourceScript',
    'targets',
    'readAt',
    'allowedReaders',
    'infisical',
    'writer',
  ];
  if (!exactKeys(o, keys)) return { problem: 'operator_meta_keys' };
  if (
    o.schema !== OPERATOR_SCHEMA ||
    o.batch !== target.batch.id ||
    o.sourceScript !== target.source
  ) {
    return { problem: 'operator_meta_identity' };
  }
  if (o.commit !== env.GITHUB_SHA) return { problem: 'operator_meta_commit' };
  if (JSON.stringify(o.targets) !== JSON.stringify(target.targets)) {
    return { problem: 'operator_meta_targets' };
  }
  const readAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(String(o.readAt))
    ? Date.parse(o.readAt)
    : NaN;
  if (!(readAt <= nowMs + 60_000 && nowMs - readAt <= TIMING.operatorMaxAgeMs)) {
    return { problem: 'operator_meta_stale' };
  }
  if (
    !Array.isArray(o.allowedReaders) ||
    o.allowedReaders.length === 0 ||
    !o.allowedReaders.every(r => typeof r === 'string' && r !== '') ||
    !exactKeys(o.infisical, ['names', 'syncs', 'imports', 'readers', 'approvalPolicies']) ||
    !isRecord(o.infisical.names) ||
    !['syncs', 'imports', 'readers', 'approvalPolicies'].every(k =>
      Array.isArray(o.infisical[k])
    ) ||
    !exactKeys(o.writer, ['clientId', 'permissions', 'auth']) ||
    !Array.isArray(o.writer.permissions) ||
    !isRecord(o.writer.auth)
  ) {
    return { problem: 'operator_meta_shape' };
  }
  if (o.writer.clientId !== env.M65_INFISICAL_CLIENT_ID) return { problem: 'operator_meta_client' };
  return { operator: o };
}

/**
 * Window: the earliest minute tick at least `leadMs` ahead whose 15-minute window the writer
 * client secret expiry fits. The core preflight requires notAfter <= expiresAt <= notAfter +
 * 15 min; not-after stays at least one minute before expiry. Refused when the secret expires more
 * than 60 minutes from now (the job never holds a longer-lived secret), or when no tick fits. On
 * the STS path also refused unless the deploy token outlives the result deadline by
 * `tokenStartMarginMs`; `tokenAbortAt` is when the run stops admitting phases.
 */
export function planRun(env, operator, nowMs) {
  const expiresAt = Date.parse(String(operator.writer.auth.clientSecretExpiresAt));
  if (!Number.isFinite(expiresAt)) return { problem: 'writer_expiry_unreadable' };
  if (expiresAt > nowMs + TIMING.maxExpiryAheadMs) return { problem: 'writer_expiry_too_far' };
  const ceilMinute = t => Math.ceil(t / MINUTE) * MINUTE;
  const latestNotAfter = Math.floor(expiresAt / MINUTE) * MINUTE - MINUTE;
  const earliestNotAfter = ceilMinute(expiresAt - TIMING.writerGraceMs);
  const notBefore = Math.max(ceilMinute(nowMs + TIMING.leadMs), earliestNotAfter - TIMING.windowMs);
  const notAfter = notBefore + TIMING.windowMs;
  if (notAfter > latestNotAfter) return { problem: 'writer_expiry_too_soon' };
  const resultDeadline = notAfter + TIMING.resultGraceMs;
  const tokenExpiresAt = tokenExpiryOf(env);
  if (!(resultDeadline + TIMING.tokenStartMarginMs <= tokenExpiresAt)) {
    return { problem: 'token_expires_too_soon' };
  }
  return {
    runId: `m65-gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.COPY_INDEX}`,
    notBefore,
    notAfter,
    armDeadline: notBefore - TIMING.armBudgetMs,
    putDeadline: notBefore - TIMING.putMarginMs,
    armedReadyDeadline: notBefore - TIMING.readyMarginMs,
    resultDeadline,
    tokenAbortAt: tokenExpiresAt - TIMING.tokenAbortMarginMs,
    cleanupDeadline:
      Math.min(
        nowMs + TIMING.stepLimitMs[env.CLOUDFLARE_TOKEN_SOURCE === 'sts' ? 'sts' : 'secret'],
        tokenExpiresAt
      ) - TIMING.cleanupSlackMs,
    out: join(
      env.RUNNER_TEMP,
      `m65-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.COPY_INDEX}.wrangler.json`
    ),
  };
}

/**
 * Child processes get only these variables; the writer secret, the operator readback and the
 * GitHub token never reach a child. HOME and XDG_CONFIG_HOME point at an empty run directory, so
 * Wrangler finds no stored login and can authenticate only with the job's sanctioned
 * CLOUDFLARE_API_TOKEN, which only Wrangler children receive. WRANGLER_WRITE_LOGS=false (M124):
 * Wrangler 4 otherwise writes its logger output, which can include token JSON, to log files.
 */
export function childEnv(env, { cloudflare = false } = {}) {
  const home = join(String(env.RUNNER_TEMP), 'runtime-copy-isolated-home');
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_WRITE_LOGS: 'false',
    ...(cloudflare
      ? { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }
      : {}),
  };
}

/** Provider data that is not an array of objects is unreadable, never partially used. */
function records(v) {
  if (!Array.isArray(v) || !v.every(isRecord)) throw new StopError('cloudflare_unreadable');
  return v;
}

/**
 * Cloudflare REST client: names-only metadata reads, plus the one cleanup delete. The delete never
 * forces, so Cloudflare refuses it if anything else references the script.
 */
export function cloudflare({
  token,
  accountId,
  fetchImpl = fetch,
  timeoutMs = TIMING.cfTimeoutMs,
}) {
  const account = `${CF_API}/accounts/${accountId}`;
  async function request(
    url,
    { allow404 = false, raw = false, method = 'GET', timeoutMs: callTimeoutMs = timeoutMs } = {}
  ) {
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(callTimeoutMs),
      });
    } catch {
      throw new StopError('cloudflare_transport');
    }
    if (res.status === 401 || res.status === 403) throw new StopError('cloudflare_unauthorized');
    if (res.status === 404 && allow404) return null;
    if (raw) {
      if (res.status !== 200) throw new StopError('cloudflare_api_error');
      return res;
    }
    let text;
    try {
      text = await res.text();
    } catch {
      throw new StopError('cloudflare_unreadable');
    }
    // The documented successful script delete has no response body.
    if (method === 'DELETE' && (res.status === 200 || res.status === 204) && text.trim() === '') {
      return { result: null, info: undefined };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new StopError('cloudflare_unreadable');
    }
    if (res.status !== 200 || body?.success !== true) throw new StopError('cloudflare_api_error');
    return { result: body.result, info: body.result_info };
  }
  const get = async (path, opts) => (await request(`${account}${path}`, opts))?.result ?? null;
  async function pages(url) {
    const out = [];
    for (let page = 1; page <= 100; page++) {
      const sep = url.includes('?') ? '&' : '?';
      const { result, info } = await request(`${url}${sep}page=${page}&per_page=50`);
      out.push(...records(result));
      if (!info || page >= (info.total_pages ?? 1)) return out;
    }
    throw new StopError('cloudflare_pagination');
  }
  const script = name => `/workers/scripts/${encodeURIComponent(name)}`;
  return {
    async scriptNames({ timeoutMs: t } = {}) {
      const ids = records(await get('/workers/scripts', { timeoutMs: t })).map(s => s.id);
      if (!ids.every(id => typeof id === 'string' && id !== '')) {
        throw new StopError('cloudflare_unreadable');
      }
      return ids.sort();
    },
    /** Current deployment's versions as the API returns them, or null when the script is absent. */
    async deploymentVersions(name, { timeoutMs: t } = {}) {
      const result = await get(`${script(name)}/deployments`, { allow404: true, timeoutMs: t });
      if (result === null) return null;
      if (!isRecord(result)) throw new StopError('cloudflare_unreadable');
      const latest = records(result.deployments)[0];
      const versions = latest === undefined ? [] : records(latest.versions);
      if (!versions.every(v => typeof v.version_id === 'string' && Number.isFinite(v.percentage))) {
        throw new StopError('cloudflare_unreadable');
      }
      return versions
        .map(v => ({ version_id: v.version_id, percentage: v.percentage }))
        .sort((a, b) => a.version_id.localeCompare(b.version_id));
    },
    /** One version's identity and its own bindings (`resources.bindings`), as returned. */
    async version(name, versionId, { timeoutMs: t } = {}) {
      const result = await get(`${script(name)}/versions/${encodeURIComponent(versionId)}`, {
        timeoutMs: t,
      });
      return {
        id: isRecord(result) ? (result.id ?? null) : null,
        bindings: isRecord(result) ? (result.resources?.bindings ?? null) : null,
      };
    },
    /** The raw settings result; the core gate judges it. */
    scriptSettings: name => get(`${script(name)}/settings`, { allow404: true }),
    async scriptStatus(name) {
      return (await get(`${script(name)}/settings`, { allow404: true })) === null ? 404 : 200;
    },
    async schedules(name) {
      const result = await get(`${script(name)}/schedules`);
      return records(isRecord(result) ? result.schedules : null).map(s => s.cron);
    },
    subdomain: name => get(`${script(name)}/subdomain`),
    /**
     * SHA-256 of each known module part. A file part is hashed as its bytes; a part without a
     * filename is re-encoded as UTF-8, which equals the uploaded bytes because parsing keeps line
     * endings (only FormData serialization normalizes them; run.test.mjs proves both on raw
     * multipart bytes). Any other part is listed as `unexpected` without hashing, so the module
     * check fails closed and nothing else is digested.
     */
    async moduleHashes(name, { timeoutMs: t } = {}) {
      const res = await request(`${account}${script(name)}/content/v2`, {
        raw: true,
        timeoutMs: t,
      });
      let form;
      try {
        form = await res.formData();
      } catch {
        throw new StopError('cloudflare_unreadable');
      }
      const hashes = {};
      for (const [part, file] of form.entries()) {
        if (!MODULES.includes(part)) {
          hashes[part] = 'unexpected';
          continue;
        }
        const bytes =
          typeof file === 'string'
            ? Buffer.from(file, 'utf8')
            : Buffer.from(await file.arrayBuffer());
        hashes[part] = createHash('sha256').update(bytes).digest('hex');
      }
      return hashes;
    },
    async doNamespaces(name) {
      const all = await pages(`${account}/workers/durable_objects/namespaces`);
      return all
        .filter(n => n.script === name)
        .map(n => ({ id: n.id, script: n.script, class: n.class }));
    },
    async domains(name) {
      const result = await get(`/workers/domains?service=${encodeURIComponent(name)}`);
      return records(result ?? []).map(d => d.hostname);
    },
    async routes(name) {
      const zones = await pages(`${CF_API}/zones?account.id=${accountId}`);
      const found = [];
      for (const zone of zones) {
        const { result } = await request(`${CF_API}/zones/${zone.id}/workers/routes`);
        for (const r of records(result ?? [])) if (r.script === name) found.push(r.pattern);
      }
      return found;
    },
    async queueConsumers(name) {
      const queues = await pages(`${account}/queues`);
      return queues.flatMap(q =>
        records(q.consumers ?? [])
          .filter(c => (c.script ?? c.service) === name)
          .map(() => q.queue_name)
      );
    },
    async workflows(name) {
      const all = await pages(`${account}/workflows`);
      return all.filter(w => w.script_name === name).map(w => w.name);
    },
    async storeSecrets(storeId) {
      const all = await pages(`${account}/secrets_store/stores/${storeId}/secrets`);
      return all.map(s => ({ id: s.id, name: s.name, status: s.status, scopes: s.scopes }));
    },
    async deleteScript(name, { timeoutMs: t } = {}) {
      await request(`${account}${script(name)}?force=false`, {
        method: 'DELETE',
        allow404: true,
        timeoutMs: t,
      });
    },
  };
}

/**
 * Read-only GitHub client for the rollout guard: workflow runs only (`actions: read`). It never
 * reads an environment; the job token cannot.
 */
export function github({ token, repository = REPOSITORY, apiUrl, fetchImpl = fetch }) {
  apiUrl ||= 'https://api.github.com';
  async function get(path) {
    let res;
    try {
      res = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMING.cfTimeoutMs),
      });
    } catch {
      throw new StopError('github_transport');
    }
    if (res.status === 404) return null;
    if (res.status !== 200) throw new StopError('github_unreadable');
    try {
      return await res.json();
    } catch {
      throw new StopError('github_unreadable');
    }
  }
  /** A named rollout workflow that is missing or unreadable is never counted as zero runs. */
  async function workflowRuns(workflow, query) {
    const body = await get(`/actions/workflows/${workflow}/runs?${query}`);
    if (!isRecord(body) || !Number.isInteger(body.total_count)) {
      throw new StopError('rollout_workflow_unreadable');
    }
    return body;
  }
  return {
    async activeRuns(workflow) {
      let count = 0;
      for (const status of ACTIVE_RUN_STATUSES) {
        count += (await workflowRuns(workflow, `status=${status}&per_page=1`)).total_count;
      }
      return count;
    },
    /** Runs created in [from, to], finished ones included; one bounded page. */
    async runsCreated(workflow, from, to) {
      const created = encodeURIComponent(`${from}..${to}`);
      const body = await workflowRuns(
        workflow,
        `created=${created}&per_page=${TIMING.rolloutRunsPerWorkflow}`
      );
      if (!Array.isArray(body.workflow_runs) || !body.workflow_runs.every(isRecord)) {
        throw new StopError('rollout_workflow_unreadable');
      }
      return {
        total: body.total_count,
        runs: body.workflow_runs.map(r => ({
          id: Number.isInteger(r.id) ? r.id : null,
          status: typeof r.status === 'string' ? r.status : null,
          conclusion: typeof r.conclusion === 'string' ? r.conclusion : null,
          createdAt: typeof r.created_at === 'string' ? r.created_at : null,
          updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
        })),
      };
    },
  };
}

/** Rollout workflows with a queued or running run; the copy never joins their concurrency group. */
export async function activeRollouts(gh) {
  const active = [];
  for (const workflow of ROLLOUT_WORKFLOWS)
    if ((await gh.activeRuns(workflow)) > 0) active.push(workflow);
  return active;
}

/**
 * Rollout runs created between the first snapshot and the cleanup snapshot, read only to explain
 * drift. `unreadable` when any workflow cannot be read; the caller never changes a verdict on it.
 */
export async function rolloutRunsDuring(gh, startMs, endMs) {
  try {
    const out = [];
    for (const workflow of ROLLOUT_WORKFLOWS) {
      out.push({
        workflow,
        ...(await gh.runsCreated(workflow, isoSeconds(startMs), isoSeconds(endMs + 999))),
      });
    }
    return out;
  } catch {
    return 'unreadable';
  }
}

/**
 * Every existing script's current deployment, by name. `deadlineMs` is the total budget: each read
 * is capped at the time left, and once none is left the snapshot stops reading and throws
 * `deadline` (never retried by `readBack`).
 */
export async function snapshot(
  cf,
  { deadlineMs = Infinity, now = Date.now, concurrency = 8 } = {}
) {
  const budget = () => {
    const left = deadlineMs - now();
    if (left <= 0) throw new StopError('deadline');
    return { timeoutMs: Math.min(TIMING.cfTimeoutMs, left) };
  };
  const names = await cf.scriptNames(budget());
  const scripts = {};
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < names.length) {
      const name = names[next++];
      try {
        scripts[name] = await cf.deploymentVersions(name, budget());
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return Object.fromEntries(
    Object.keys(scripts)
      .sort()
      .map(n => [n, scripts[n]])
  );
}

/** Script names whose deployment differs, ignoring this run's copier. */
export function drift(before, after, ignore) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .sort()
    .filter(n => !ignore.includes(n))
    .filter(n => JSON.stringify(before[n] ?? null) !== JSON.stringify(after[n] ?? null));
}

/**
 * A script's current deployment and, when exactly one version serves 100%, that version's own
 * identity and bindings. The core gates require that single serving version.
 */
export async function servingVersion(cf, name, opts) {
  const deployments = (await cf.deploymentVersions(name, opts)) ?? [];
  const only =
    deployments.length === 1 &&
    deployments[0].percentage === 100 &&
    UUID.test(deployments[0].version_id)
      ? deployments[0].version_id
      : null;
  return { deployments, version: only === null ? null : await cf.version(name, only, opts) };
}

const storeMeta = async (cf, batch) => ({
  id: batch.rows[0].storeId,
  secrets: await cf.storeSecrets(batch.rows[0].storeId),
});

/**
 * Copier, source and store metadata in the shape the core preflight reads, plus the serving
 * version of every other table Worker that binds one of this batch's shared targets (M142 live
 * parity).
 */
export async function cloudflareMeta(cf, target, table = TABLE) {
  const { copier: name } = target;
  const source = await servingVersion(cf, target.source);
  const copier = await servingVersion(cf, name);
  const binders = {};
  for (const { worker } of sharedBinders(target.batch, table)) {
    binders[worker] ??= await servingVersion(cf, worker);
  }
  return {
    source,
    store: await storeMeta(cf, target.batch),
    sharedBinders: binders,
    copier: {
      doNamespaces: await cf.doNamespaces(name),
      deployments: copier.deployments,
      version: copier.version,
      settings: await cf.scriptSettings(name),
      subdomain: await cf.subdomain(name),
      routes: await cf.routes(name),
      domains: await cf.domains(name),
      queueConsumers: await cf.queueConsumers(name),
      workflows: await cf.workflows(name),
      schedules: await cf.schedules(name),
      modules: await cf.moduleHashes(name),
    },
  };
}

const TRANSIENT = new Set([
  'cloudflare_transport',
  'cloudflare_api_error',
  'cloudflare_unreadable',
]);

/**
 * A read that hits a transient failure is read once more, unless the retry would start at or
 * after `deadlineMs`. Never used for a mutation.
 */
export async function readBack(io, read, deadlineMs = Infinity) {
  try {
    return await read();
  } catch (err) {
    if (!(err instanceof StopError) || !TRANSIENT.has(err.reason)) throw err;
    const now = () => io.clock?.now() ?? Date.now();
    if (now() + TIMING.readRetryMs >= deadlineMs) throw err;
    await (io.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(TIMING.readRetryMs);
    return read();
  }
}

const sameHashes = (got, want) =>
  isRecord(got) &&
  JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(want).sort()) &&
  Object.keys(want).every(k => got[k] === want[k]);

/** Each run var appears exactly once in `bindings` as plain text equal to this run's pin. */
const carriesPins = (bindings, pins) =>
  RUN_VARS.every(k => {
    const hits = bindings.filter(b => b.name === k);
    return hits.length === 1 && hits[0].type === 'plain_text' && hits[0].text === pins[k];
  });

/**
 * The copier's serving version after the unarmed deploy, attributed to this run only when the
 * provider's version id matches the single 100% deployment, its own bindings carry this run's
 * unique pins and no writer secret, and the script's modules equal the tracked source. Null when
 * any of that is not proved; such a version is never recorded, so cleanup never deletes it.
 */
export async function attributeUnarmed(io, pins, copier) {
  const observed = await readBack(io, () => servingVersion(io.cf, copier));
  const v = observed.version;
  if (!v || v.id !== observed.deployments[0].version_id) return null;
  if (!Array.isArray(v.bindings) || !v.bindings.every(isRecord)) return null;
  if (v.bindings.some(b => b.name === WRITER_SECRET) || !carriesPins(v.bindings, pins)) return null;
  const modules = await readBack(io, () => io.cf.moduleHashes(copier));
  return sameHashes(modules, moduleHashes()) ? v.id : null;
}

/**
 * Splits `wrangler tail --format json` stdout into events. Wrangler prints each event as an
 * indented JSON object; anything outside an object (banners) is skipped.
 */
export function jsonObjectSplitter(onObject) {
  let buf = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  return chunk => {
    for (const ch of chunk) {
      if (depth === 0) {
        if (ch !== '{') continue;
        buf = '';
      }
      buf += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        try {
          onObject(JSON.parse(buf));
        } catch {
          // An unparsable event is not a receipt.
        }
      }
    }
  };
}

/** This run's parsed receipts from one tail event. Exceptions are counted, never read. */
export function receiptsOf(event, runId, batch) {
  const receipts = [];
  for (const log of Array.isArray(event?.logs) ? event.logs : []) {
    for (const item of Array.isArray(log?.message) ? log.message : []) {
      const { ok, receipt } = parseReceipt(item, batch);
      if (ok && receipt.runId === runId) receipts.push(receipt);
    }
  }
  return { receipts, exceptions: Array.isArray(event?.exceptions) ? event.exceptions.length : 0 };
}

const allReady = r => r.ready !== null && Object.values(r.ready).every(v => v === true);

export const unarmedReady = versionId => r =>
  r.versionId === versionId &&
  r.outcome === 'unarmed' &&
  r.reason === 'writer_not_installed' &&
  r.armed === false &&
  r.window === 'before' &&
  r.gate === 'not_attempted' &&
  r.logins === 0 &&
  r.reads === 0 &&
  r.posts === 0 &&
  allReady(r);

export const armedReady = versionId => r =>
  r.versionId === versionId &&
  r.outcome === 'idle' &&
  r.reason === 'outside_window' &&
  r.armed === true &&
  r.window === 'before' &&
  r.gate === 'not_attempted' &&
  r.logins === 0 &&
  r.reads === 0 &&
  r.posts === 0 &&
  allReady(r);

/**
 * A receipt from the armed version that ends the wait: a final outcome, a refusal, an idle
 * receipt after consumption (the final line was missed, so postrun fails), or a closed window.
 */
export const finalFor = versionId => r =>
  r.versionId === versionId &&
  (OUTCOMES.includes(r.outcome) ||
    r.outcome === 'refused' ||
    (r.outcome === 'idle' && (r.reason !== 'outside_window' || r.window === 'closed')));

/** Rejects with `stopped_by_signal` as soon as `signal` aborts. */
export function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new StopError('stopped_by_signal'));
  return new Promise((done, fail) => {
    const onAbort = () => fail(new StopError('stopped_by_signal'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => {
        signal.removeEventListener('abort', onAbort);
        done(v);
      },
      e => {
        signal.removeEventListener('abort', onAbort);
        fail(e);
      }
    );
  });
}

/**
 * Waits for the earliest receipt that matches, until `deadlineMs`; null when none arrived. A stop
 * signal ends the wait at once.
 */
export async function awaitReceipt(tail, runId, matches, deadlineMs, stats, signal, batch) {
  for (;;) {
    const event = await untilAborted(tail.next(deadlineMs), signal);
    if (event === null) return null;
    const { receipts, exceptions } = receiptsOf(event, runId, batch);
    stats.exceptions += exceptions;
    stats.receipts += receipts.length;
    const hit = receipts.find(matches);
    if (hit) return hit;
  }
}

const errorCodes = output => [...new Set(String(output).match(/\[code: \d{4,6}\]/g) ?? [])];

/**
 * Stops a child: `first` signal, then SIGKILL, each waited for at most `graceMs`.
 * Returns `exited`, `killed`, or `stuck` (still not closed after SIGKILL).
 */
export async function stopChild(child, graceMs = TIMING.killGraceMs, first = 'SIGINT') {
  if (child.exitCode !== null || child.signalCode !== null) return 'exited';
  const closed = new Promise(r => child.once('close', () => r(true)));
  const within = ms =>
    Promise.race([closed, new Promise(r => setTimeout(() => r(false), ms).unref())]);
  child.kill(first);
  if (await within(graceMs)) return 'exited';
  child.kill('SIGKILL');
  return (await within(graceMs)) ? 'killed' : 'stuck';
}

/**
 * Runs one child with stdin, bounded by `timeoutMs` and by `signal`: on either it gets SIGTERM,
 * then SIGKILL. Returns `{code, output}`; `stopped` names why it was stopped. A spawn failure is
 * code -1, never a throw.
 */
export function runChild(command, args, { env, stdin, timeoutMs, signal, graceMs } = {}) {
  return new Promise(done => {
    let child;
    try {
      child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      done({ code: -1, output: '' });
      return;
    }
    let output = '';
    let stopped = null;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done(result);
    };
    const stop = reason => {
      if (stopped || settled) return;
      stopped = reason;
      const grace =
        reason === 'signal'
          ? Math.min(graceMs ?? TIMING.killGraceMs, TIMING.abortGraceMs)
          : graceMs;
      stopChild(child, grace, 'SIGTERM').then(exit => finish({ code: -1, output, stopped, exit }));
    };
    const onAbort = () => stop('signal');
    const timer = setTimeout(() => stop('timeout'), Math.max(0, timeoutMs ?? 0));
    signal?.addEventListener('abort', onAbort, { once: true });
    const keep = d => {
      output = (output + d).slice(-65_536);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', () => finish({ code: -1, output, stopped }));
    child.on('close', code => {
      if (!stopped) finish({ code: code ?? -1, output });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
    if (signal?.aborted) onAbort();
  });
}

export function processIo(env, signal) {
  const plain = childEnv(env);
  const withToken = childEnv(env, { cloudflare: true });
  const ensureHome = () => mkdirSync(plain.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  const hasToken = () =>
    typeof withToken.CLOUDFLARE_API_TOKEN === 'string' && withToken.CLOUDFLARE_API_TOKEN !== '';
  function exec(
    command,
    args,
    { stdin, timeoutMs = TIMING.processTimeoutMs, cloudflare = false } = {}
  ) {
    if (cloudflare && !hasToken()) return Promise.resolve({ code: -1, output: '' });
    ensureHome();
    return runChild(command, args, {
      env: cloudflare ? withToken : plain,
      stdin,
      timeoutMs,
      signal,
    });
  }
  return {
    wrangler: (args, opts) => exec(WRANGLER_BIN, args, { ...opts, cloudflare: true }),
    node: (args, opts) => exec(process.execPath, args, opts),
    startTail(clock, copier) {
      if (!hasToken()) throw new StopError('cloudflare_token_absent');
      ensureHome();
      const child = spawn(WRANGLER_BIN, ['tail', copier, '--format', 'json'], {
        cwd: REPO_ROOT,
        env: withToken,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const queue = [];
      let wake = () => {};
      let closed = false;
      const onClosed = () => {
        closed = true;
        wake();
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on(
        'data',
        jsonObjectSplitter(obj => {
          queue.push(obj);
          wake();
        })
      );
      child.on('error', onClosed);
      child.on('close', onClosed);
      return {
        async next(deadlineMs) {
          while (queue.length === 0) {
            if (closed) throw new StopError('tail_closed');
            const left = deadlineMs - clock.now();
            if (left <= 0) return null;
            await new Promise(r => {
              const t = setTimeout(r, left);
              wake = () => {
                clearTimeout(t);
                r();
              };
            });
            wake = () => {};
          }
          return queue.shift();
        },
        stop: () =>
          closed
            ? Promise.resolve('exited')
            : stopChild(child, signal?.aborted ? TIMING.abortGraceMs : TIMING.killGraceMs),
      };
    },
  };
}

/** Gate verdicts as reported: gate, ok and failure codes only (never pins or inputs). */
export const verdictOf = v => ({ gate: v.gate, ok: v.ok, failures: [...v.failures] });

/** Time left before `deadline`, capped at the process timeout; holds when none is left. */
function boundBy(clock, deadline) {
  const left = deadline - clock.now();
  if (left <= 0) throw new StopError('held_arm_deadline');
  return Math.min(TIMING.processTimeoutMs, left);
}

function writeFailed(reason, output) {
  const err = new StopError(reason);
  err.codes = errorCodes(output);
  return err;
}

/**
 * The whole run. `io` supplies the clock, Cloudflare client, process runners, tail and an
 * optional stop signal, so the synthetic tests drive every branch without a provider. Returns the
 * names-only report.
 */
export async function run(io) {
  const { env, clock, cf, log, signal } = io;
  const table = io.table ?? TABLE;
  const target = targetOf(env.COPY_WORKER, table);
  const report = {
    schema: 'runtime-copy-run/1',
    status: 'started',
    worker: target?.worker ?? null,
    tokenSource: ['secret', 'sts'].includes(env.CLOUDFLARE_TOKEN_SOURCE)
      ? env.CLOUDFLARE_TOKEN_SOURCE
      : null,
    batchTargets: target ? [...target.targets] : [],
    phases: [],
    gates: [],
  };
  // STS path: from tokenAbortAt on no phase starts and no wait or child outlives it; the run goes
  // straight to cleanup while the deploy token still has `tokenAbortMarginMs` left.
  let tokenAbortAt = Infinity;
  const pastTokenAbort = () => clock.now() >= tokenAbortAt;
  const phase = (name, { stoppable = true } = {}) => {
    if (stoppable && signal?.aborted) throw new StopError('stopped_by_signal');
    if (stoppable && pastTokenAbort()) throw new StopError('token_expiry_abort');
    report.phases.push({ name, at: isoSeconds(clock.now()) });
    log({ phase: name });
  };
  const bound = deadline => {
    if (pastTokenAbort()) throw new StopError('token_expiry_abort');
    return boundBy(clock, Math.min(deadline, tokenAbortAt));
  };
  const waitFor = async (matches, deadline) => {
    const hit = await awaitReceipt(
      tail,
      plan.runId,
      matches,
      Math.min(deadline, tokenAbortAt),
      stats,
      signal,
      batch
    );
    if (!hit && pastTokenAbort()) throw new StopError('token_expiry_abort');
    return hit;
  };
  // The in-run deployment snapshots: a transient read is read once more, and neither runs past
  // the token abort time.
  const snapshotInRun = async () => {
    try {
      return await readBack(
        io,
        () => snapshot(cf, { deadlineMs: tokenAbortAt, now: () => clock.now() }),
        tokenAbortAt
      );
    } catch (err) {
      if (err instanceof StopError && err.reason === 'deadline') {
        throw new StopError('token_expiry_abort');
      }
      throw err;
    }
  };

  const problems = contextProblems(env, io.headSha, table);
  if (problems.length) return { ...report, status: 'refused', problems };
  const { batch, copier } = target;
  const secret = env[WRITER_SECRET];
  const parsed = parseOperatorMeta(env[OPERATOR_META], env, clock.now(), target);
  delete env[WRITER_SECRET];
  delete env[OPERATOR_META];
  if (parsed.problem) return { ...report, status: 'refused', problems: [parsed.problem] };
  const { operator } = parsed;
  const plan = planRun(env, operator, clock.now());
  if (plan.problem) return { ...report, status: 'refused', problems: [plan.problem] };
  tokenAbortAt = plan.tokenAbortAt;
  if (Number.isFinite(tokenAbortAt)) report.tokenAbortAt = isoSeconds(tokenAbortAt);
  Object.assign(report, {
    runId: plan.runId,
    notBefore: isoSeconds(plan.notBefore),
    notAfter: isoSeconds(plan.notAfter),
  });
  const pins = {
    M65_RUN_ID: plan.runId,
    M65_BATCH: target.worker,
    M65_NOT_BEFORE: report.notBefore,
    M65_NOT_AFTER: report.notAfter,
    M65_INFISICAL_CLIENT_ID: env.M65_INFISICAL_CLIENT_ID,
  };

  const recorded = new Set();
  const stats = { receipts: 0, exceptions: 0 };
  let created = false;
  let before = null;
  let since = null;
  let tail = null;

  try {
    phase('name_table');
    const names = (io.nameTable ?? (b => validatedNameTable(b, REPO_ROOT, table)))(batch);
    report.gates.push(verdictOf(names));
    if (!names.ok) throw new StopError('name_table_refused');
    io.printTable(names.table);

    phase('github_guards');
    const rolloutsAtStart = await activeRollouts(io.gh);
    if (rolloutsAtStart.length) {
      report.activeRollouts = rolloutsAtStart;
      throw new StopError('rollout_active');
    }

    phase('snapshot_before');
    since = clock.now();
    before = await snapshotInRun();
    if (copier in before || (await cf.scriptStatus(copier)) !== 404) {
      throw new StopError('copier_exists');
    }
    report.preexistingScripts = Object.keys(before).length;

    phase('render');
    const rendered = await io.node([
      RENDER_CONFIG,
      '--run-id',
      pins.M65_RUN_ID,
      '--batch',
      pins.M65_BATCH,
      '--not-before',
      pins.M65_NOT_BEFORE,
      '--not-after',
      pins.M65_NOT_AFTER,
      '--client-id',
      pins.M65_INFISICAL_CLIENT_ID,
      '--out',
      plan.out,
    ]);
    let config = null;
    try {
      config = JSON.parse(rendered.output.trim().split('\n').at(-1));
    } catch {
      config = null;
    }
    if (
      rendered.code !== 0 ||
      config?.name !== copier ||
      config.configPath !== plan.out ||
      config.notBefore !== pins.M65_NOT_BEFORE ||
      config.notAfter !== pins.M65_NOT_AFTER
    ) {
      throw new StopError('render_refused');
    }
    // Digest of the rendered config file, which holds names, pins and paths, never a secret.
    report.configSha256 = config.configSha256;

    phase('deploy_unarmed');
    const deployTimeout = bound(plan.armDeadline);
    created = true;
    const deployed = await io.wrangler(['deploy', '--config', plan.out], {
      timeoutMs: deployTimeout,
    });
    report.deployWrite = deployed.code === 0 ? 'proved' : 'unproved';
    const unarmedVersion = await attributeUnarmed(io, pins, copier);
    if (unarmedVersion) {
      recorded.add(unarmedVersion);
      report.unarmedVersion = unarmedVersion;
    }
    if (deployed.code !== 0) throw writeFailed('wrangler_deploy_failed', deployed.output);
    if (!unarmedVersion) throw new StopError('copier_deployment_unattributable');

    phase('await_unarmed_readiness');
    tail = io.startTail(clock, copier);
    const unarmed = await waitFor(unarmedReady(unarmedVersion), plan.armDeadline);
    if (!unarmed) throw new StopError('held_no_readiness_tick');
    report.cronReadyAt = isoSeconds(clock.now());

    phase('preflight_gate');
    const preflight = evaluatePreflight(
      {
        meta: {
          ...(await cloudflareMeta(cf, target, table)),
          ...operatorPreflightMeta(operator),
        },
        pins,
        deployedVersionId: unarmedVersion,
        allowedReaders: operator.allowedReaders,
        readinessReceipt: unarmed,
        nowMs: clock.now(),
      },
      batch,
      WORKER_SOURCES,
      table
    );
    report.gates.push(verdictOf(preflight));
    if (!preflight.ok) throw new StopError('preflight_gate_failed');

    phase('guards_before_arm');
    const rolloutsBeforeArm = await activeRollouts(io.gh);
    if (rolloutsBeforeArm.length) {
      report.activeRollouts = rolloutsBeforeArm;
      throw new StopError('rollout_active_before_arm');
    }
    const preArm = drift(before, await snapshotInRun(), [copier]);
    if (preArm.length) {
      report.drift = preArm;
      throw new StopError('drift_before_arm');
    }
    const serving = await cf.deploymentVersions(copier);
    if (
      serving?.length !== 1 ||
      serving[0].percentage !== 100 ||
      serving[0].version_id !== unarmedVersion
    ) {
      throw new StopError('copier_changed_before_arm');
    }
    if (clock.now() >= plan.armDeadline) throw new StopError('held_arm_deadline');

    phase('arm');
    const putTimeout = bound(plan.putDeadline);
    report.armWrite = 'unproved';
    const put = await io.wrangler(['secret', 'put', WRITER_SECRET, '--config', plan.out], {
      stdin: secret,
      timeoutMs: putTimeout,
    });

    // Runs even after a stop signal: an unread put result is never left unattributed. A signal
    // that landed during the put makes each read run once with the short abort timeout.
    phase('arm_readback', { stoppable: false });
    const quick = signal?.aborted ? { timeoutMs: TIMING.abortCallTimeoutMs } : undefined;
    const readOnce = read => (quick ? read() : readBack(io, read));
    const observed = await readOnce(() => servingVersion(cf, copier, quick));
    const armedId = observed.deployments.length === 1 ? observed.deployments[0].version_id : null;
    const armed = bindArmedPreflight(preflight, armedId, observed);
    report.gates.push(verdictOf(armed));
    const modulesKept = sameHashes(
      await readOnce(() => cf.moduleHashes(copier, quick)),
      moduleHashes()
    );
    if (armed.ok && modulesKept) {
      recorded.add(armedId);
      report.armedVersion = armedId;
    } else if (modulesKept && carriesThisRun(observed, armedId, pins)) {
      // Cleanup only: a post-put version with this run's unique pins and the tracked modules is
      // this run's to delete. It never stands in for the armed proof or the post-run pin.
      recorded.add(armedId);
      report.cleanupAttributedVersion = armedId;
    }
    if (put.code !== 0) throw writeFailed('secret_put_unproved', put.output);
    if (!armed.ok || !modulesKept) throw new StopError('arm_readback_refused');
    report.armWrite = 'proved';
    report.preflightPins = armed.pins;

    phase('await_armed_readiness');
    const armedReceipt = await waitFor(armedReady(armedId), plan.armedReadyDeadline);
    if (!armedReceipt) throw new StopError('held_no_armed_readiness');

    phase('await_result');
    const final = await waitFor(finalFor(armedId), plan.resultDeadline);
    if (!final) throw new StopError('result_unobserved');
    report.finalReceipt = final;

    phase('postrun_cloudflare_gate');
    const postrun = evaluatePostRunCloudflare(
      {
        pre: armed,
        meta: {
          source: await servingVersion(cf, target.source),
          store: await storeMeta(cf, batch),
        },
        receipt: final,
      },
      batch
    );
    report.gates.push(verdictOf(postrun));
    report.status = postrun.ok ? 'cloudflare_complete' : 'incomplete';
  } catch (err) {
    report.status = 'stopped';
    report.stopReason = err instanceof StopError ? err.reason : 'internal';
    if (err?.codes?.length) report.errorCodes = err.codes;
  } finally {
    try {
      report.cleanup = await cleanup(io, {
        created,
        recorded,
        before,
        plan,
        since,
        copier,
        source: target.source,
        aborted: signal?.aborted === true,
      });
    } finally {
      report.tail = { ...stats, stop: tail ? ((await tail.stop()) ?? 'stopped') : 'not_started' };
    }
  }
  // The cleanup deadline cut a read off: the entry fails as a token-expiry abort, report printed.
  if (report.cleanup?.deadlineReached) {
    if (report.stopReason && report.stopReason !== 'token_expiry_abort') {
      report.firstStopReason = report.stopReason;
    }
    report.status = 'stopped';
    report.stopReason = 'token_expiry_abort';
  }
  const unresolved = [];
  if (report.armWrite === 'unproved') unresolved.push('secret_put_unproved');
  if (created && report.cleanup.scriptStatus !== 404) unresolved.push('copier_not_proved_deleted');
  if (signal?.aborted) unresolved.push('stopped_by_signal');
  if (unresolved.length) {
    report.unresolved = unresolved;
    // Before not-before no copy can have run yet: revoking the writer now prevents it outright.
    report.operatorAction =
      report.cleanup.beforeNotBefore === true
        ? 'REVOKE THE WRITER NOW'
        : 'revoke_writer_then_read_back_copier';
  }
  return report;
}

/** The single 100% post-put version, read by its id, carries this run's pins exactly once each. */
function carriesThisRun(observed, versionId, pins) {
  const v = observed?.version;
  return (
    typeof versionId === 'string' &&
    isRecord(v) &&
    v.id === versionId &&
    Array.isArray(v.bindings) &&
    v.bindings.every(isRecord) &&
    carriesPins(v.bindings, pins)
  );
}

/** The operator readback keys the core preflight reads; CI adds nothing to them. */
export function operatorPreflightMeta(operator) {
  return {
    infisical: operator.infisical,
    writer: operator.writer,
  };
}

/**
 * Deletes the copier only when every version it serves was attributed by this run. Every step
 * catches its own failure and records it by name, so a malformed response never skips the report;
 * a failed read never leads to a delete. After a stop signal only one read and one delete run, each
 * once with the short abort timeout (no retry, status, namespace read, snapshot or rollout
 * listing), so the cleanup gate stays failed and the job's last seconds go to the delete; a
 * SIGKILL can still land first.
 * `plan.cleanupDeadline` bounds the rest: every read and retry is capped there. Past it the copier
 * read and delete still run once each with the short timeout, every later read is skipped
 * (`<step>:deadline`), an unread snapshot is `drift: 'not_read_by_deadline'`, and
 * `deadlineReached` fails the entry.
 */
export async function cleanup(
  io,
  { created, recorded, before, plan, since, copier, source, aborted = false }
) {
  const { cf, clock } = io;
  const result = { attempted: false, deleted: false, scriptStatus: null, drift: null, errors: [] };
  // Unknown timing counts as before not-before, so the report asks for the urgent revoke.
  const beforeNotBefore = () =>
    Number.isFinite(plan?.notBefore) ? clock.now() < plan.notBefore : true;
  if (!created) {
    return {
      attempted: false,
      deleted: false,
      scriptStatus: 404,
      drift: null,
      note: 'not_created',
      beforeNotBefore: beforeNotBefore(),
    };
  }
  const deadline = Number.isFinite(plan?.cleanupDeadline) ? plan.cleanupDeadline : Infinity;
  const pastDeadline = () => clock.now() >= deadline;
  const step = async (name, fn) => {
    try {
      return { value: await fn() };
    } catch (err) {
      result.errors.push(`${name}:${err instanceof StopError ? err.reason : 'internal'}`);
      return null;
    }
  };
  // A later read that the deadline leaves no time for is skipped and recorded.
  const bounded = (name, fn) => {
    if (!pastDeadline()) return step(name, () => readBack(io, fn, deadline));
    result.errors.push(`${name}:deadline`);
    result.deadlineReached = true;
    return null;
  };
  // After a stop signal or past the deadline: one read and one delete, each with the short timeout
  // and no retry; after a stop signal also no status read (the operator reads the copier back).
  const quick = { timeoutMs: TIMING.abortCallTimeoutMs };
  const hurry = aborted || pastDeadline();
  const capped = () =>
    hurry
      ? quick
      : {
          timeoutMs: Math.max(
            TIMING.abortCallTimeoutMs,
            Math.min(TIMING.cfTimeoutMs, deadline - clock.now())
          ),
        };
  const read = await step('read', () =>
    hurry
      ? cf.deploymentVersions(copier, quick)
      : readBack(io, () => cf.deploymentVersions(copier, capped()), deadline)
  );
  const versions = read?.value;
  if (read && versions === null) {
    result.scriptStatus = 404;
  } else if (read && versions.length > 0 && versions.every(v => recorded.has(v.version_id))) {
    result.attempted = true;
    result.deleted = (await step('delete', () => cf.deleteScript(copier, capped()))) !== null;
    if (!aborted) {
      const status = await bounded('status', () => cf.scriptStatus(copier));
      if (status) result.scriptStatus = status.value;
    }
  } else if (read) {
    result.scriptStatus = 200;
    result.note = 'unattributable_versions';
  }
  if (aborted) {
    result.aborted = true;
  } else {
    if (result.scriptStatus === 404) {
      const ns = await bounded('namespaces', () => cf.doNamespaces(copier));
      if (ns) result.gateNamespacePresent = ns.value.length > 0;
    }
  }
  let after = null;
  if (before && !aborted) {
    const snap = await bounded('snapshot', () =>
      snapshot(cf, { deadlineMs: deadline, now: () => clock.now() })
    );
    if (snap) {
      after = snap.value;
      result.drift = drift(before, after, [copier]);
    } else if (result.errors.includes('snapshot:deadline')) {
      result.drift = 'not_read_by_deadline';
      result.deadlineReached = true;
    }
  }
  const verdict = evaluateCleanupCloudflare({
    meta: {
      copier: {
        scriptStatus: result.scriptStatus,
        gateNamespacePresent: result.gateNamespacePresent,
      },
      sourceUnchanged:
        after !== null && JSON.stringify(before[source]) === JSON.stringify(after[source]),
      existingDeploymentsUnchanged: Array.isArray(result.drift) && result.drift.length === 0,
    },
  });
  result.gate = verdictOf(verdict);
  if (Array.isArray(result.drift) && result.drift.length && since !== null && !pastDeadline()) {
    result.rolloutRuns = await rolloutRunsDuring(io.gh, since, clock.now());
  }
  if (result.errors.length === 0) delete result.errors;
  result.at = isoSeconds(clock.now());
  result.beforeNotBefore = beforeNotBefore();
  return result;
}

/**
 * 0 only when the Cloudflare half is complete: the final receipt passed, the copier and its gate
 * namespace are gone, and no other Worker changed. The operator's Infisical half follows privately.
 */
export function exitCode(report) {
  return report.status === 'cloudflare_complete' && report.cleanup?.gate?.ok === true ? 0 : 1;
}

async function gitHead() {
  const { execFileSync } = await import('node:child_process');
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function main() {
  const env = { ...process.env };
  delete process.env[WRITER_SECRET];
  delete process.env[OPERATOR_META];
  // Cancel and timeout arrive as SIGINT, then SIGTERM: stop admitting phases, unblock any wait,
  // stop a running child, then clean up. Later signals change nothing.
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const clock = { now: () => Date.now() };
  const log = line => process.stdout.write(`${JSON.stringify(line)}\n`);
  const printTable = text => process.stdout.write(`${text}\n`);
  const report = await run({
    ...processIo(env, controller.signal),
    env,
    clock,
    log,
    printTable,
    signal: controller.signal,
    headSha: await gitHead(),
    cf: cloudflare({ token: env.CLOUDFLARE_API_TOKEN, accountId: ACCOUNT_ID }),
    gh: github({ token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL }),
  });
  log(report);
  if (report.operatorAction) {
    process.stdout.write(`::error title=Runtime copy operator action::${report.operatorAction}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `### Runtime copy: ${report.worker ?? 'refused'}\n\n${report.operatorAction ? `**Operator action: ${report.operatorAction}**\n\n` : ''}\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
    );
  }
  return exitCode(report);
}

/**
 * The workflow's first job: no secret, no environment, no GitHub API call. The dispatch identity
 * and the whole row table (`validateTable`), then every table Worker's name check
 * (`validatedNameTable`; a Worker whose reader or policy is not on main yet refuses as
 * `source_not_on_main: <worker>`). Any failure refuses the whole dispatch: no subset of the table
 * runs. The workflow never reads the protected environments: the operator reads each one back
 * with admin rights before dispatch, and GitHub enforces its protection when the copy job starts.
 * `table` is the checked-in table and `root` the checkout (tests pass a fixture). Returns
 * {gate:"plan", ok, failures, workers}; `workers` is the matrix, in table order.
 */
export function planMatrix({ env, headSha, table = TABLE, root = REPO_ROOT }) {
  const failures = [
    ...dispatchProblems(env, headSha),
    ...table.problems.map(p => `table_${p}`),
    ...table.workers.flatMap(w =>
      validatedNameTable(table.batches[w], root, table).failures.map(f =>
        f === `source_not_on_main: ${w}` || f === `policy_unreadable: ${w}` ? f : `${w}:${f}`
      )
    ),
  ];
  const ok = failures.length === 0 && table.workers.length > 0;
  return { gate: 'plan', ok, failures, workers: ok ? [...table.workers] : [] };
}

async function planMain() {
  const env = process.env;
  const verdict = planMatrix({ env, headSha: await gitHead() });
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (verdict.ok && env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `workers=${JSON.stringify(verdict.workers)}\n`);
  }
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode =
    process.argv[2] === '--plan' && process.argv.length === 3
      ? await planMain()
      : process.argv.length === 2
        ? await main()
        : 2;
}
