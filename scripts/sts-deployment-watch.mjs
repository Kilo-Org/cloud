// Monitor of the STS Worker outside STS (services/sts README, Cloudflare deploy tokens, setup
// step 7). STS's own window check cannot report a change to the STS Worker of its environment, so
// this job, run by GitHub on a schedule, lists the Cloudflare deployments of `sts` and
// `sts-staging` and reports each one that no STS deploy job of this repository made.
//
// `watch` reads Cloudflare with a token that holds only Workers Scripts Read, and GitHub with the
// job's own token (actions: read). Each run checks the deployments made since the previous
// successful scheduled run on main started, so a delayed or failed run leaves no gap; a run that
// cannot check fails, and the workflow posts that failure. `health` uses only the job's GitHub
// token: it alerts when the watch has had no successful scheduled run on main for 45 minutes, so
// a revoked Cloudflare token, a disabled schedule or a broken workflow cannot silence the watch.

import { appendFileSync } from 'node:fs';

export const CLOUDFLARE_ACCOUNT_ID = 'e115e769bcdd4c3d66af59d3332cb394';

/** The STS Worker script of each environment, as named in services/sts/wrangler.jsonc. */
export const STS_SCRIPTS = { production: 'sts', staging: 'sts-staging' };

/** The workflows that deploy Workers, and the environment each deploys to (null: either). */
export const DEPLOY_WORKFLOWS = {
  '.github/workflows/deploy-production.yml': 'production',
  '.github/workflows/deploy-staging.yml': 'staging',
  '.github/workflows/deploy-workers.yml': null,
};

/** A job deploying STS: `Deploy services/sts`, or the same under a calling job's name. */
const STS_DEPLOY_JOB = /(^|\/ )Deploy services\/sts$/;

/**
 * What a deploy job's `wrangler deploy` leaves on the Cloudflare deployment. Cloudflare records no
 * author for an API token, so a `wrangler deploy` with any other token looks the same; only a
 * deployment made another way (the dashboard, a rollback, a secret change) is told apart by this.
 */
export const CI_DEPLOYMENT = { source: 'wrangler', triggeredBy: 'deployment' };

/** Slack between a job's clock and Cloudflare's, on each side of the job's run time. */
export const JOB_MARGIN_BEFORE_MS = 60_000;
export const JOB_MARGIN_AFTER_MS = 120_000;

/** How far before the window a deploy run may have been created and still deploy in it. */
export const RUN_LOOKBACK_MS = 6 * 60 * 60_000;

/** The first run looks back this far; no run looks back further than the maximum. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The previous successful run's start, less this, opens the window. */
export const WINDOW_OVERLAP_MS = 5 * 60_000;

/** `health` alerts when the last successful scheduled watch run on main started longer ago. */
export const STALE_AFTER_MS = 45 * 60_000;

const WATCH_RUNS =
  'actions/workflows/sts-deployment-watch.yml/runs?status=success&branch=main&event=schedule&per_page=1';

/**
 * Where this run's window opens: the previous successful run's start less the overlap, else the
 * default window, never more than the maximum back. `clamped` says deployments older than the
 * window may have gone unchecked.
 */
export function windowStart(now, previousSuccessStartedAt) {
  const floor = now - MAX_WINDOW_MS;
  if (previousSuccessStartedAt === null) return { since: now - DEFAULT_WINDOW_MS, clamped: false };
  const since = previousSuccessStartedAt - WINDOW_OVERLAP_MS;
  return since < floor ? { since: floor, clamped: true } : { since, clamped: false };
}

/** Runs that may hold a deploy job overlapping the window: a run last updated before it cannot. */
export function runsToCheck(runs, since) {
  return runs.filter(run => !(Date.parse(run.updated_at) + JOB_MARGIN_AFTER_MS < since));
}

/**
 * The STS deploy jobs of the given runs: `{ environment, from, to, url }`, each a time span (ms)
 * a deployment made by that job falls in. `environment` is null for a run of the manual workflow,
 * whose target the API does not show.
 */
export function deployJobSpans(runs, now) {
  const spans = [];
  for (const { run, jobs } of runs) {
    if (!(run.path in DEPLOY_WORKFLOWS)) continue;
    for (const job of jobs) {
      if (!STS_DEPLOY_JOB.test(job.name) || !job.started_at || job.conclusion === 'skipped')
        continue;
      spans.push({
        environment: DEPLOY_WORKFLOWS[run.path],
        from: Date.parse(job.started_at) - JOB_MARGIN_BEFORE_MS,
        to: (job.completed_at ? Date.parse(job.completed_at) : now) + JOB_MARGIN_AFTER_MS,
        url: job.html_url,
      });
    }
  }
  return spans;
}

/**
 * Each deployment created at or after `since` that is not a `wrangler deploy` inside an STS
 * deploy job span of its environment. `deployments` is `{ environment, script, deployment }`.
 */
export function unexpectedDeployments(deployments, spans, since) {
  return deployments.filter(({ environment, deployment }) => {
    const created = Date.parse(deployment.created_on);
    if (!(created >= since)) return false;
    const byWrangler =
      deployment.source === CI_DEPLOYMENT.source &&
      deployment.annotations?.['workers/triggered_by'] === CI_DEPLOYMENT.triggeredBy;
    if (!byWrangler) return true;
    return !spans.some(
      span =>
        (span.environment === null || span.environment === environment) &&
        created >= span.from &&
        created <= span.to
    );
  });
}

/** Cloudflare-supplied text for a Slack mrkdwn field: no markup, no code-span breakout. */
export function escapeMrkdwn(value) {
  return String(value ?? 'unknown')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[`*_~]/g, '')
    .slice(0, 120);
}

/** The Slack message for the unexpected deployments, and for a clamped window. */
export function slackPayload({ found, clamped, since }, runUrl) {
  const lines = found.map(({ script, deployment }) => {
    const by = deployment.annotations?.['workers/triggered_by'];
    return `• ${script} deployment ${escapeMrkdwn(deployment.id)} at ${escapeMrkdwn(deployment.created_on)}, source ${escapeMrkdwn(deployment.source)}, triggered by ${escapeMrkdwn(by)}`;
  });
  if (clamped) {
    lines.push(
      `• The previous successful watch run is older than 7 days: deployments before ${new Date(since).toISOString()} were not checked. Compare them by hand in the dashboard.`
    );
  }
  const text =
    found.length > 0
      ? `STS Worker deployment that no STS deploy job made (${found.length}). Check it now: a replaced STS Worker can read every bundle and the Cloudflare minting token.`
      : 'STS deployment watch could not check its whole window.';
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'STS deployment watch' } },
      { type: 'section', text: { type: 'mrkdwn', text: `${text}\n${lines.join('\n')}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `<${runUrl}|Watch run>` } },
    ],
  };
}

/** Whether the watch is stale: no successful scheduled run on main within `STALE_AFTER_MS`. */
export function isStale(now, lastSuccessStartedAt, workflowCreatedAt) {
  if (lastSuccessStartedAt !== null) return now - lastSuccessStartedAt > STALE_AFTER_MS;
  return now - workflowCreatedAt > STALE_AFTER_MS;
}

function requireEnv(env, names) {
  for (const name of names) if (!env[name]) throw new Error(`${name} is not set`);
}

async function getJson(fetchImpl, url, headers) {
  const response = await fetchImpl(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} answered ${response.status}`);
  return response.json();
}

function github(env) {
  return {
    api: `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}`,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
  };
}

/** One watch run. Returns the outputs it writes: `found`, `clamped` and, when either, `payload`. */
export async function watch({ env, fetch: fetchImpl, now }) {
  requireEnv(env, ['CLOUDFLARE_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY']);
  const gh = github(env);
  const previous = await getJson(fetchImpl, `${gh.api}/${WATCH_RUNS}`, gh.headers);
  const lastStart = previous.workflow_runs?.[0]?.run_started_at;
  const { since, clamped } = windowStart(now, lastStart ? Date.parse(lastStart) : null);

  const deployments = [];
  for (const [environment, script] of Object.entries(STS_SCRIPTS)) {
    const body = await getJson(
      fetchImpl,
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${script}/deployments`,
      { authorization: `Bearer ${env.CLOUDFLARE_TOKEN}` }
    );
    if (body.success !== true || !Array.isArray(body.result?.deployments)) {
      throw new Error(`Cloudflare deployments of ${script} could not be read`);
    }
    for (const deployment of body.result.deployments)
      deployments.push({ environment, script, deployment });
  }

  const created = new Date(since - RUN_LOOKBACK_MS).toISOString();
  const runs = [];
  for (const path of Object.keys(DEPLOY_WORKFLOWS)) {
    const file = path.split('/').pop();
    const list = await getJson(
      fetchImpl,
      `${gh.api}/actions/workflows/${file}/runs?created=%3E%3D${encodeURIComponent(created)}&per_page=100`,
      gh.headers
    );
    for (const run of runsToCheck(list.workflow_runs ?? [], since)) {
      const jobs = await getJson(
        fetchImpl,
        `${gh.api}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
        gh.headers
      );
      runs.push({ run, jobs: jobs.jobs ?? [] });
    }
  }

  const found = unexpectedDeployments(deployments, deployJobSpans(runs, now), since);
  const checked = deployments.filter(
    item => Date.parse(item.deployment.created_on) >= since
  ).length;
  console.log(
    `checked ${checked} deployment(s) since ${new Date(since).toISOString()} against ${runs.length} deploy run(s); unexpected: ${found.length}${clamped ? '; window clamped to 7 days' : ''}`
  );
  if (clamped)
    console.log('::warning::The window was clamped to 7 days; older deployments were not checked.');
  const runUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const outputs = { found: String(found.length), clamped: String(clamped) };
  if (found.length > 0 || clamped)
    outputs.payload = JSON.stringify(slackPayload({ found, clamped, since }, runUrl));
  return outputs;
}

/** One health run. Returns `{ stale }`. */
export async function health({ env, fetch: fetchImpl, now }) {
  requireEnv(env, ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']);
  const gh = github(env);
  const workflow = await getJson(
    fetchImpl,
    `${gh.api}/actions/workflows/sts-deployment-watch.yml`,
    gh.headers
  );
  const runs = await getJson(fetchImpl, `${gh.api}/${WATCH_RUNS}`, gh.headers);
  const lastStart = runs.workflow_runs?.[0]?.run_started_at;
  const stale = isStale(
    now,
    lastStart ? Date.parse(lastStart) : null,
    Date.parse(workflow.created_at)
  );
  console.log(
    `last successful scheduled watch run on main: ${lastStart ?? 'none'}; stale: ${stale}`
  );
  return { stale: String(stale) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2];
  const job = mode === 'watch' ? watch : mode === 'health' ? health : null;
  if (!job) {
    console.error('::error::usage: node scripts/sts-deployment-watch.mjs watch|health');
    process.exit(2);
  }
  job({ env: process.env, fetch: globalThis.fetch, now: Date.now() })
    .then(outputs => {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set');
      for (const [key, value] of Object.entries(outputs))
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    })
    .catch(error => {
      console.error(`::error::${error.message}`);
      process.exit(1);
    });
}
