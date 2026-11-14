import { type SSH_AUTH_METHODS } from '@/lib/persist/schema';

import { type SshDatabase } from './database';
import { createForward } from './forwards';
import { createHost, getHost, type SshHost, updateHost } from './hosts';
import {
  forwardsOf,
  isRepeatableDirective,
  type SshConfigForwardDraft,
} from './ssh-config-forward';
import { parseSshConfig, type SshConfigBlock, type SshConfigEntry } from './ssh-config-parse';

type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/** Something the preview says about a host before it is imported. */
export type SshConfigWarning =
  | { kind: 'needsKey'; identityFile: string }
  | { kind: 'jumpHostMissing'; target: string }
  | { kind: 'jumpHostMultiHop' }
  | { kind: 'jumpHostCycle'; target: string }
  | { kind: 'forwardUnsupported'; directive: string };

export type SshConfigHostDraft = Readonly<{
  alias: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  /** The `IdentityFile` the config names, which the app cannot import. */
  identityFile: string | null;
  /** The jump target: an alias of this batch, or a label of an existing host. */
  jumpTarget: string | null;
  /** The existing host a jump target already names, when it names one. */
  jumpHostId: string | null;
  forwards: readonly SshConfigForwardDraft[];
  warnings: readonly SshConfigWarning[];
}>;

type SshConfigSkipReason = 'noUsername' | 'invalidPort';

export type SshConfigSkippedHost = Readonly<{ alias: string; reason: SshConfigSkipReason }>;

export type SshConfigPlan = Readonly<{
  hosts: readonly SshConfigHostDraft[];
  skipped: readonly SshConfigSkippedHost[];
  /** The order the first imported host takes, after every host already stored. */
  startSortOrder: number;
}>;

const WILDCARD_PATTERN = /[*?[]/;

function firstValue(entries: readonly SshConfigEntry[], key: string): string | null {
  return entries.find(entry => entry.key === key)?.value ?? null;
}

function portOf(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/**
 * Adds the block's directives to one alias, keeping every repeatable line and
 * the first value of every other directive.
 */
function mergeEntriesInto(
  target: { alias: string; entries: SshConfigEntry[] },
  entries: readonly SshConfigEntry[]
): void {
  for (const entry of entries) {
    if (isRepeatableDirective(entry.key) || firstValue(target.entries, entry.key) === null) {
      target.entries.push(entry);
    }
  }
}

/**
 * One `Host` line per pattern that is not a wildcard, with the directives of
 * every later block naming the same alias folded in. OpenSSH resolves a host's
 * own blocks by the first value each directive has, so the first one wins;
 * directives a block may repeat keep every line.
 */
function mergeHostBlocks(
  blocks: readonly SshConfigBlock[]
): Map<string, { alias: string; entries: SshConfigEntry[] }> {
  const merged = new Map<string, { alias: string; entries: SshConfigEntry[] }>();
  for (const block of blocks) {
    const patterns = block.kind === 'host' ? block.patterns : [];
    for (const pattern of patterns) {
      if (!WILDCARD_PATTERN.test(pattern)) {
        const key = pattern.toLowerCase();
        const target = merged.get(key) ?? { alias: pattern, entries: [] };
        merged.set(key, target);
        mergeEntriesInto(target, block.entries);
      }
    }
  }
  return merged;
}

/** The host part of a ProxyJump target, without its `user@` or `:port`. */
function jumpHostKey(target: string): string {
  const hostPart = target.slice(target.lastIndexOf('@') + 1);
  const bracketed = /^\[([^\]]+)]/.exec(hostPart);
  return (bracketed?.[1] ?? hostPart.split(':')[0] ?? '').toLowerCase();
}

type JumpResolution = Readonly<{
  target: string | null;
  hostId: string | null;
  warnings: readonly SshConfigWarning[];
}>;

function resolveJump(
  value: string | null,
  batch: ReadonlyMap<string, string>,
  existingByLabel: ReadonlyMap<string, SshHost>
): JumpResolution {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'none') {
    return { target: null, hostId: null, warnings: [] };
  }
  const hops = trimmed
    .split(',')
    .map(hop => hop.trim())
    .filter(hop => hop.length > 0);
  const target = hops[0] ?? '';
  const warnings: SshConfigWarning[] = hops.length > 1 ? [{ kind: 'jumpHostMultiHop' }] : [];
  const key = jumpHostKey(target);
  const batchAlias = batch.get(key);
  if (batchAlias !== undefined) {
    return { target: batchAlias, hostId: null, warnings };
  }
  const existing = existingByLabel.get(key);
  if (existing) {
    return { target: existing.label, hostId: existing.id, warnings };
  }
  return {
    target: null,
    hostId: null,
    warnings: [...warnings, { kind: 'jumpHostMissing', target }],
  };
}

/** Whether `kept`'s chain of accepted jumps already walks from `start` to `goal`. */
function chainReaches(kept: ReadonlyMap<string, string>, start: string, goal: string): boolean {
  const seen = new Set<string>();
  let current: string | null = start;
  while (current !== null && !seen.has(current)) {
    if (current === goal) {
      return true;
    }
    seen.add(current);
    current = kept.get(current) ?? null;
  }
  return false;
}

/**
 * Drops a jump that would loop inside this batch. Drafts are read in file order
 * and a jump is kept only while the jumps already kept do not walk back to the
 * host that names it, so one side of a mutual jump keeps its route and the
 * other is reported instead of failing the whole import in the store.
 */
function withResolvedJumps(drafts: readonly SshConfigHostDraft[]): SshConfigHostDraft[] {
  const kept = new Map<string, string>();
  const resolved: SshConfigHostDraft[] = [];
  for (const draft of drafts) {
    const target = draft.jumpTarget?.toLowerCase() ?? null;
    const own = draft.alias.toLowerCase();
    if (target !== null && chainReaches(kept, target, own)) {
      resolved.push({
        ...draft,
        jumpTarget: null,
        jumpHostId: null,
        warnings: [...draft.warnings, { kind: 'jumpHostCycle', target: draft.jumpTarget ?? '' }],
      });
    } else {
      if (target !== null) {
        kept.set(own, target);
      }
      resolved.push(draft);
    }
  }
  return resolved;
}

/**
 * The hosts a config file describes, in file order, with everything the
 * preview needs to explain what it will and will not import.
 *
 * A `Host` line naming several patterns stores each pattern that is not a
 * wildcard; a wildcard names a rule for many hosts rather than one host to
 * keep. Directives before the first `Host` line are defaults for every host.
 */
export function planSshConfigImport(text: string, existing: readonly SshHost[]): SshConfigPlan {
  const blocks = parseSshConfig(text);
  const globals = blocks.flatMap(block => (block.kind === 'global' ? block.entries : []));
  const merged = mergeHostBlocks(blocks);
  const existingByLabel = new Map(existing.map(host => [host.label.toLowerCase(), host]));
  const batch = new Map([...merged].map(([key, host]) => [key, host.alias]));
  const drafts: SshConfigHostDraft[] = [];
  const skipped: SshConfigSkippedHost[] = [];

  function draftOf(alias: string, entries: readonly SshConfigEntry[]): SshConfigHostDraft | null {
    const username = (firstValue(entries, 'user') ?? firstValue(globals, 'user') ?? '').trim();
    if (username.length === 0) {
      skipped.push({ alias, reason: 'noUsername' });
      return null;
    }
    const port = portOf(firstValue(entries, 'port') ?? firstValue(globals, 'port') ?? '22');
    if (port === null) {
      skipped.push({ alias, reason: 'invalidPort' });
      return null;
    }
    const identityFile = firstValue(entries, 'identityfile') ?? firstValue(globals, 'identityfile');
    const jump = resolveJump(firstValue(entries, 'proxyjump'), batch, existingByLabel);
    const { forwards, failed } = forwardsOf(entries);
    const warnings: SshConfigWarning[] = [...jump.warnings];
    if (identityFile !== null) {
      warnings.push({ kind: 'needsKey', identityFile });
    }
    for (const directive of failed) {
      warnings.push({ kind: 'forwardUnsupported', directive });
    }
    return {
      alias,
      hostname: (firstValue(entries, 'hostname') ?? alias).trim(),
      port,
      username,
      authMethod: identityFile === null ? 'password' : 'key',
      identityFile,
      jumpTarget: jump.target,
      jumpHostId: jump.hostId,
      forwards,
      warnings,
    };
  }

  for (const { alias, entries } of merged.values()) {
    const draft = draftOf(alias, entries);
    if (draft !== null) {
      drafts.push(draft);
    }
  }

  let startSortOrder = 0;
  for (const host of existing) {
    startSortOrder = Math.max(startSortOrder, host.sortOrder + 1);
  }

  return { hosts: withResolvedJumps(drafts), skipped, startSortOrder };
}

export type SshConfigImportResult = Readonly<{ hosts: SshHost[]; forwardCount: number }>;

/**
 * Writes the checked hosts, their jumps and their forwards as one transaction:
 * a config that fails partway leaves the store exactly as it was. The rows
 * returned are read back after their jump is applied, so they describe what
 * was stored rather than what was inserted.
 */
export function importSshConfig(
  db: SshDatabase,
  plan: SshConfigPlan,
  at: number = Date.now()
): SshConfigImportResult {
  const results: SshConfigImportResult[] = [];
  db.withTransactionSync(() => {
    const ids = new Map<string, string>();
    const hosts = plan.hosts.map((draft, index) => {
      const host = createHost(
        db,
        {
          label: draft.alias,
          hostname: draft.hostname,
          port: draft.port,
          username: draft.username,
          authMethod: draft.authMethod,
          sortOrder: plan.startSortOrder + index,
        },
        at
      );
      ids.set(draft.alias.toLowerCase(), host.id);
      return host;
    });
    const forwards = plan.hosts.flatMap((draft, index) => {
      const host = hosts[index];
      return host === undefined ? [] : [{ draft, host }];
    });
    let forwardCount = 0;
    for (const { draft, host } of forwards) {
      const jumpHostId =
        draft.jumpTarget === null
          ? draft.jumpHostId
          : (ids.get(draft.jumpTarget.toLowerCase()) ?? draft.jumpHostId);
      if (jumpHostId !== null) {
        updateHost(db, host.id, { jumpHostId });
      }
      for (const forward of draft.forwards) {
        createForward(db, { hostId: host.id, ...forward });
        forwardCount += 1;
      }
    }
    const written = hosts.flatMap(host => getHost(db, host.id) ?? []);
    results.push({ hosts: written, forwardCount });
  });
  const result = results[0];
  if (result === undefined) {
    throw new Error('ssh import: the transaction produced no result');
  }
  return result;
}
