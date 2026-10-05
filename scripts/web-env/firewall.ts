import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopyFirewallOptions, PathRewrite } from './options.js';
import {
  VercelApiError,
  confirm,
  isRecord,
  records,
  resolveVercelContexts,
  stringValue,
  vercelApi,
  type JsonRecord,
  type VercelContext,
} from './shared.js';

type RuleRewrite = { rule: string; from: string; to: string };

export type FirewallCopy = {
  body: JsonRecord;
  rewrites: RuleRewrite[];
  review: string[];
};

// Ops whose value is a whole path or a path prefix, so a prefix rewrite keeps
// the meaning. Suffix, substring and regex values are reported for review.
const REWRITABLE_PATH_OPS = new Set(['eq', 'neq', 'pre', 'inc', 'ninc']);

function rewritePath(value: string, rewrites: readonly PathRewrite[]): string {
  const match = rewrites.find(rewrite => value.startsWith(rewrite.from));
  return match ? match.to + value.slice(match.from.length) : value;
}

function copyConditionGroups(
  rule: string,
  groups: unknown,
  rewrites: readonly PathRewrite[],
  copy: FirewallCopy
): JsonRecord[] {
  const seen = new Set<string>();
  const result: JsonRecord[] = [];
  for (const group of records(groups)) {
    const conditions = records(group.conditions).map(condition => {
      if (condition.type !== 'path') return condition;
      const op = stringValue(condition, 'op');
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      const strings = values.filter((value): value is string => typeof value === 'string');
      if (strings.length !== values.length) return condition;
      if (!op || !REWRITABLE_PATH_OPS.has(op)) {
        if (strings.some(value => rewrites.some(rewrite => value.includes(rewrite.from)))) {
          copy.review.push(`${rule}: path condition with op ${op ?? 'unknown'} was not rewritten`);
        }
        return condition;
      }
      const rewritten = strings.map(value => {
        const next = rewritePath(value, rewrites);
        if (next !== value) copy.rewrites.push({ rule, from: value, to: next });
        return next;
      });
      return {
        ...condition,
        value: Array.isArray(condition.value) ? rewritten : rewritten[0],
      };
    });
    const copied = { ...group, conditions };
    const key = JSON.stringify(copied);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(copied);
  }
  return result;
}

function activeActionMap(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]))
    .map(([name, rule]) => [
      name,
      { active: rule.active === true, ...(rule.action ? { action: rule.action } : {}) },
    ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

/**
 * Builds a `PUT /v1/security/firewall/config` body from the active config of
 * another project. Read-only fields (IDs, versions, validation results, audit
 * metadata) are dropped; everything else is copied as-is.
 */
export function firewallCopyBody(
  source: JsonRecord,
  rewrites: readonly PathRewrite[]
): FirewallCopy {
  for (const unsupported of ['rulesets', 'conditions']) {
    if (hasEntries(source[unsupported])) {
      throw new Error(`The source firewall uses ${unsupported}, which this command cannot copy.`);
    }
  }
  if (typeof source.firewallEnabled !== 'boolean') {
    throw new Error('The source firewall config has no firewallEnabled flag.');
  }

  const orderedRewrites = [...rewrites].sort((left, right) => right.from.length - left.from.length);
  const copy: FirewallCopy = { body: {}, rewrites: [], review: [] };
  const rules = records(source.rules).map(rule => {
    const name = stringValue(rule, 'name') ?? 'unnamed rule';
    if (rule.valid === false) copy.review.push(`${name}: Vercel marks this rule as invalid`);
    if (
      records(rule.conditionGroup).some(group =>
        records(group.conditions).some(condition => condition.type === 'host')
      )
    ) {
      copy.review.push(`${name}: matches on host, which differs between projects`);
    }
    return {
      name,
      ...(typeof rule.description === 'string' ? { description: rule.description } : {}),
      active: rule.active === true,
      conditionGroup: copyConditionGroups(name, rule.conditionGroup, orderedRewrites, copy),
      action: rule.action,
    };
  });

  const ips = records(source.ips).map(ip => ({
    hostname: ip.hostname,
    ip: ip.ip,
    ...(typeof ip.notes === 'string' ? { notes: ip.notes } : {}),
    action: ip.action,
  }));

  const crs = activeActionMap(source.crs);
  const managedRules = activeActionMap(source.managedRules);
  copy.body = {
    firewallEnabled: source.firewallEnabled,
    rules,
    ips,
    ...(crs ? { crs } : {}),
    ...(managedRules ? { managedRules } : {}),
    ...(typeof source.botIdEnabled === 'boolean' ? { botIdEnabled: source.botIdEnabled } : {}),
    ...(source.logHeaders !== undefined ? { logHeaders: source.logHeaders } : {}),
  };
  return copy;
}

function activeFirewallConfig(context: VercelContext): JsonRecord | undefined {
  try {
    return vercelApi(
      context,
      `/v1/security/firewall/config/active?projectId=${encodeURIComponent(context.project)}`,
      `Read the ${context.project} firewall`
    );
  } catch (error) {
    if (error instanceof VercelApiError && error.code === 'not_found') return undefined;
    throw error;
  }
}

function systemBypassCount(context: VercelContext): number {
  const response = vercelApi(
    context,
    `/v1/security/firewall/bypass?projectId=${encodeURIComponent(context.project)}&limit=256`,
    `Read the ${context.project} system bypass rules`
  );
  return records(response.result).length;
}

function activeCount(value: unknown): number {
  return isRecord(value)
    ? Object.values(value).filter(entry => isRecord(entry) && entry.active === true).length
    : 0;
}

function summary(config: JsonRecord | undefined): string {
  if (!config) return 'no firewall config';
  const rules = records(config.rules);
  return [
    `firewall ${config.firewallEnabled === true ? 'enabled' : 'disabled'}`,
    `${rules.length} custom rules (${rules.filter(rule => rule.active === true).length} active)`,
    `${records(config.ips).length} IP rules`,
    `${activeCount(config.crs)} OWASP (crs) rules active`,
    `${activeCount(config.managedRules)} managed rulesets active`,
  ].join(', ');
}

export async function runCopyFirewall(options: CopyFirewallOptions): Promise<void> {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kilo-web-env-'));

  try {
    console.log('Checking Vercel access...');
    const { contexts, missingProjects } = resolveVercelContexts(tempDirectory);
    for (const project of [options.from, options.to]) {
      if (missingProjects.includes(project)) {
        throw new Error(`The Vercel project ${project} does not exist yet.`);
      }
    }
    const source = contexts.find(context => context.project === options.from);
    const destination = contexts.find(context => context.project === options.to);
    if (!source || !destination) throw new Error('Could not resolve the Vercel projects.');

    console.log(`Reading the ${options.from} and ${options.to} firewalls...`);
    const sourceConfig = activeFirewallConfig(source);
    if (!sourceConfig) throw new Error(`${options.from} has no firewall config to copy.`);
    const destinationConfig = activeFirewallConfig(destination);
    const bypassRules = systemBypassCount(source);
    const copy = firewallCopyBody(sourceConfig, options.rewritePaths);

    console.log(`\nPlan: replace the ${options.to} firewall with the ${options.from} one`);
    console.log(`- ${options.from} now: ${summary(sourceConfig)}`);
    console.log(`- ${options.to} now: ${summary(destinationConfig)}`);
    console.log(`- ${options.to} after: ${summary(copy.body)}`);
    for (const rule of records(copy.body.rules))
      console.log(`  - rule: ${stringValue(rule, 'name')}`);
    if (copy.rewrites.length > 0) {
      console.log('- Path rewrites:');
      for (const rewrite of copy.rewrites) {
        console.log(`  - ${rewrite.rule}: ${rewrite.from} -> ${rewrite.to}`);
      }
    }
    if (copy.review.length > 0) {
      console.log('- Review before applying:');
      for (const note of copy.review) console.log(`  - ${note}`);
    }
    if (bypassRules > 0) {
      console.log(`- Not copied: ${bypassRules} system bypass rules; recreate them in Vercel.`);
    }
    console.log('- Not copied: Attack Challenge Mode, which is a temporary per-project switch.');

    if (options.dryRun) {
      console.log('\nDry run complete; nothing changed.');
      return;
    }
    if (!(await confirm(`\nReplace the ${options.to} firewall config?`))) {
      console.log('Cancelled; nothing changed.');
      return;
    }

    console.log(`Updating the ${options.to} firewall...`);
    vercelApi(
      destination,
      `/v1/security/firewall/config?projectId=${encodeURIComponent(destination.project)}`,
      `Update the ${options.to} firewall`,
      { method: 'PUT', body: copy.body }
    );
    console.log(`- ${options.to} now: ${summary(activeFirewallConfig(destination))}`);
    console.log('\nDone. Rerun the same command if the update failed.');
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
