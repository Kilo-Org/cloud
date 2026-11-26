// Monitor of the STS Worker outside STS (services/sts README, Cloudflare deploy tokens, setup
// step 7). STS's own window check cannot report a change to the STS Worker of its environment, so
// this job, run by GitHub on a schedule, lists the Cloudflare deployments of `sts` and
// `sts-staging` and reports each one that no STS deploy job of this repository made.
//
// It reads with a Cloudflare token that holds only Workers Scripts Read, and reads GitHub with the
// job's own token (actions: read). Each run checks the deployments made since the previous
// successful run started, so a delayed or failed run leaves no gap; a run that cannot check fails
// and the next one covers its window too.

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

/** Slack between a job's clock and Cloudflare's, on each side of the job's run time. */
export const JOB_MARGIN_BEFORE_MS = 60_000;
export const JOB_MARGIN_AFTER_MS = 120_000;

/** How far before the window a deploy run may have been created and still deploy in it. */
export const RUN_LOOKBACK_MS = 6 * 60 * 60_000;

/** The first run, or one after a long outage, looks back this far and no further. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The previous successful run's start, less this, opens the window. */
export const WINDOW_OVERLAP_MS = 5 * 60_000;

/**
 * Where this run's window opens: the previous successful run's start less the overlap, else the
 * default window, never more than the maximum back.
 */
export function windowStart(now, previousSuccessStartedAt) {
  const floor = now - MAX_WINDOW_MS;
  if (previousSuccessStartedAt === null) return Math.max(now - DEFAULT_WINDOW_MS, floor);
  return Math.max(previousSuccessStartedAt - WINDOW_OVERLAP_MS, floor);
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
 * Each deployment created at or after `since` that no STS deploy job span of its environment
 * covers. `deployments` is `{ environment, script, deployment }` with Cloudflare's deployment.
 */
export function unexpectedDeployments(deployments, spans, since) {
  return deployments.filter(({ environment, deployment }) => {
    const created = Date.parse(deployment.created_on);
    if (!(created >= since)) return false;
    return !spans.some(
      span =>
        (span.environment === null || span.environment === environment) &&
        created >= span.from &&
        created <= span.to
    );
  });
}

/** The Slack message for the unexpected deployments. */
export function slackPayload(found, runUrl) {
  const lines = found.map(({ script, deployment }) => {
    const annotations = deployment.annotations ?? {};
    const by = annotations['workers/triggered_by'] ?? 'unknown';
    return `• \`${script}\` deployment \`${deployment.id}\` at ${deployment.created_on}, source ${deployment.source ?? 'unknown'}, triggered by ${by}, author ${deployment.author_email ?? 'unknown'}`;
  });
  const text = `STS Worker deployment that no STS deploy job made (${found.length}). Check it now: a replaced STS Worker can read every bundle and the Cloudflare minting token.`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Unexpected STS deployment' } },
      { type: 'section', text: { type: 'mrkdwn', text: `${text}\n${lines.join('\n')}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `<${runUrl}|Watch run>` } },
    ],
  };
}

async function getJson(url, headers) {
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GET ${new URL(url).pathname} answered ${response.status}`);
  return response.json();
}

async function main() {
  const env = process.env;
  for (const name of ['CLOUDFLARE_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const now = Date.now();
  const api = `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}`;
  const gh = { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' };
  const cf = { authorization: `Bearer ${env.CLOUDFLARE_TOKEN}` };

  const previous = await getJson(
    `${api}/actions/workflows/sts-deployment-watch.yml/runs?status=success&per_page=1`,
    gh
  );
  const lastStart = previous.workflow_runs?.[0]?.run_started_at;
  const since = windowStart(now, lastStart ? Date.parse(lastStart) : null);

  const deployments = [];
  for (const [environment, script] of Object.entries(STS_SCRIPTS)) {
    const body = await getJson(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${script}/deployments`,
      cf
    );
    if (!body.success || !Array.isArray(body.result?.deployments)) {
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
      `${api}/actions/workflows/${file}/runs?created=%3E%3D${encodeURIComponent(created)}&per_page=100`,
      gh
    );
    for (const run of list.workflow_runs ?? []) {
      const jobs = await getJson(`${api}/actions/runs/${run.id}/jobs?filter=all&per_page=100`, gh);
      runs.push({ run, jobs: jobs.jobs ?? [] });
    }
  }

  const found = unexpectedDeployments(deployments, deployJobSpans(runs, now), since);
  console.log(
    `checked ${deployments.filter(item => Date.parse(item.deployment.created_on) >= since).length} deployment(s) since ${new Date(since).toISOString()} against ${runs.length} deploy run(s); unexpected: ${found.length}`
  );
  for (const { script, deployment } of found) {
    console.log(`unexpected: ${script} ${deployment.id} ${deployment.created_on}`);
  }
  const runUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  appendFileSync(env.GITHUB_OUTPUT, `found=${found.length}\n`);
  if (found.length > 0)
    appendFileSync(env.GITHUB_OUTPUT, `payload=${JSON.stringify(slackPayload(found, runUrl))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
