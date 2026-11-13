import { SSH_AUTH_METHODS } from '@/lib/persist/schema';

import { type SshDatabase } from './database';
import { createForward } from './forwards';
import { createHost, type SshHost, updateHost } from './hosts';
import { parseSshConfig, type SshConfigBlock, type SshConfigEntry } from './ssh-config-parse';

type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/** Something the preview says about a host before it is imported. */
export type SshConfigWarning =
  | { kind: 'needsKey'; identityFile: string }
  | { kind: 'jumpHostMissing'; target: string }
  | { kind: 'jumpHostMultiHop' }
  | { kind: 'jumpHostCycle'; target: string }
  | { kind: 'forwardUnsupported'; directive: string };

export type SshConfigForwardDraft = Readonly<{
  direction: 'local' | 'remote';
  bindHost: string;
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
}>;

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

export type SshConfigSkipReason = 'noUsername' | 'invalidPort';

export type SshConfigSkippedHost = Readonly<{ alias: string; reason: SshConfigSkipReason }>;

export type SshConfigPlan = Readonly<{
  hosts: readonly SshConfigHostDraft[];
  skipped: readonly SshConfigSkippedHost[];
  /** The order the first imported host takes, after every host already stored. */
  startSortOrder: number;
}>;

const WILDCARD_PATTERN = /[*?[]/;

function forwardDirectionOf(key: string): SshConfigForwardDraft['direction'] | null {
  if (key === 'localforward') {
    return 'local';
  }
  return key === 'remoteforward' ? 'remote' : null;
}

function firstValue(entries: readonly SshConfigEntry[], key: string): string | null {
  return entries.find(entry => entry.key === key)?.value ?? null;
}

function portOf(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

type HostAndPort = Readonly<{ host: string | null; port: number | null }>;

function splitHostAndPort(token: string): HostAndPort {
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(token);
  if (bracketed) {
    return { host: bracketed[1] ?? null, port: portOf(bracketed[2] ?? '') };
  }
  const colon = token.lastIndexOf(':');
  if (colon === -1) {
    return { host: null, port: portOf(token) };
  }
  return { host: token.slice(0, colon), port: portOf(token.slice(colon + 1)) };
}

/**
 * One `LocalForward`/`RemoteForward` line, in either of OpenSSH's shapes:
 * `port host:hostport` and `[bind_address:]port host:hostport`. A Unix socket
 * target, or a port outside 1-65535, is not a forward this app can store.
 */
function parseForward(
  direction: SshConfigForwardDraft['direction'],
  value: string
): SshConfigForwardDraft | null {
  const tokens = value.split(/\s+/).filter(token => token.length > 0);
  let bindToken = tokens[0];
  let destinationToken = tokens[1];
  if (tokens.length === 1 && bindToken !== undefined) {
    const parts = bindToken.split(':');
    if (parts.length !== 3) {
      return null;
    }
    bindToken = parts[0];
    destinationToken = `${parts[1] ?? ''}:${parts[2] ?? ''}`;
  }
  if (bindToken === undefined || destinationToken === undefined) {
    return null;
  }
  const bind = splitHostAndPort(bindToken);
  const destination = splitHostAndPort(destinationToken);
  if (bind.port === null || destination.port === null || destination.host === null) {
    return null;
  }
  return {
    direction,
    bindHost: bind.host ?? '127.0.0.1',
    bindPort: bind.port,
    destinationHost: destination.host,
    destinationPort: destination.port,
  };
}

/** The host part of a ProxyJump target, without its `user@` or `:port`. */
function jumpHostKey(target: string): string {
  const hostPart = target.slice(target.lastIndexOf('@') + 1);
  const bracketed = /^\[([^\]]+)]/.exec(hostPart);
  const host = bracketed?.[1] ?? hostPart.split(':')[0] ?? '';
  return host.toLowerCase();
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
  return { target: null, hostId: null, warnings: [...warnings, { kind: 'jumpHostMissing', target }] };
}

type HostDraftResult =
  | { kind: 'draft'; draft: SshConfigHostDraft }
  | { kind: 'skipped'; skipped: SshConfigSkippedHost };

function forwardsOf(entries: readonly SshConfigEntry[]): {
  forwards: SshConfigForwardDraft[];
  warnings: SshConfigWarning[];
} {
  const forwards: SshConfigForwardDraft[] = [];
  const warnings: SshConfigWarning[] = [];
  for (const entry of entries) {
    const direction = forwardDirectionOf(entry.key);
    if (direction !== null) {
      const forward = parseForward(direction, entry.value);
      if (forward === null) {
        warnings.push({ kind: 'forwardUnsupported', directive: entry.key });
      } else {
        forwards.push(forward);
      }
    }
  }
  return { forwards, warnings };
}

function draftOfHost(
  alias: string,
  entries: readonly SshConfigEntry[],
  globalEntries: readonly SshConfigEntry[],
  batch: ReadonlyMap<string, string>,
  existingByLabel: ReadonlyMap<string, SshHost>
): HostDraftResult {
  const username = (firstValue(entries, 'user') ?? firstValue(globalEntries, 'user') ?? '').trim();
  if (username.length === 0) {
    return { kind: 'skipped', skipped: { alias, reason: 'noUsername' } };
  }
  const port = portOf(firstValue(entries, 'port') ?? firstValue(globalEntries, 'port') ?? '22');
  if (port === null) {
    return { kind: 'skipped', skipped: { alias, reason: 'invalidPort' } };
  }
  const identityFile =
    firstValue(entries, 'identityfile') ?? firstValue(globalEntries, 'identityfile');
  const jump = resolveJump(firstValue(entries, 'proxyjump'), batch, existingByLabel);
  const { forwards, warnings: forwardWarnings } = forwardsOf(entries);
  const warnings: SshConfigWarning[] = [...jump.warnings, ...forwardWarnings];
  if (identityFile !== null) {
    warnings.push({ kind: 'needsKey', identityFile });
  }
  return {
    kind: 'draft',
    draft: {
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
    },
  };
}

function mergeHostBlocks(
  blocks: readonly SshConfigBlock[]
): Map<string, { alias: string; entries: SshConfigEntry[] }> {
  const merged = new Map<string, { alias: string; entries: SshConfigEntry[] }>();
  for (const block of blocks) {
    if (block.kind === 'host') {
      for (const pattern of block.patterns) {
        if (!WILDCARD_PATTERN.test(pattern)) {
          const key = pattern.toLowerCase();
          const target = merged.get(key) ?? { alias: pattern, entries: [] };
          merged.set(key, target);
          for (const entry of block.entries) {
            if (firstValue(target.entries, entry.key) === null) {
              target.entries.push(entry);
            }
          }
        }
      }
    }
  }
  return merged;
}

/**
 * The hosts a config file describes, in file order, with everything the
 * preview needs to explain what it will and will not import.
 *
 * A `Host` line naming several patterns stores each pattern that is not a
 * wildcard; a wildcard names a rule for many hosts rather than one host to
 * keep. When several blocks name one alias, the first value each directive has
 * wins, the way OpenSSH resolves a single host's own blocks. Directives before
 * the first `Host` line are defaults for every imported host.
 */
export function planSshConfigImport(text: string, existing: readonly SshHost[]): SshConfigPlan {
  const blocks = parseSshConfig(text);
  const globalEntries = blocks.flatMap(block => (block.kind === 'global' ? block.entries : []));
  const merged = mergeHostBlocks(blocks);
  const existingByLabel = new Map(existing.map(host => [host.label.toLowerCase(), host]));
  const batchAliases = new Map([...merged].map(([key, host]) => [key, host.alias]));
  const drafts: SshConfigHostDraft[] = [];
  const skipped: SshConfigSkippedHost[] = [];

  for (const { alias, entries } of merged.values()) {
    const result = draftOfHost(alias, entries, globalEntries, batchAliases, existingByLabel);
    if (result.kind === 'draft') {
      drafts.push(result.draft);
    } else {
      skipped.push(result.skipped);
    }
  }

  let startSortOrder = 0;
  for (const host of existing) {
    startSortOrder = Math.max(startSortOrder, host.sortOrder + 1);
  }

  return { hosts: withResolvedJumps(drafts), skipped, startSortOrder };
}

/**
 * Drops a jump that would loop inside this batch. The store refuses a loop
 * outright, and a config with two hosts jumping through each other is a
 * mistake the preview should report instead of failing the whole import.
 */
function withResolvedJumps(drafts: readonly SshConfigHostDraft[]): SshConfigHostDraft[] {
  const targetOf = new Map(
    drafts
      .filter(draft => draft.jumpTarget !== null)
      .map(draft => [draft.alias.toLowerCase(), draft.jumpTarget?.toLowerCase() ?? null])
  );
  return drafts.map(draft => {
    const own = draft.alias.toLowerCase();
    let current = draft.jumpTarget?.toLowerCase() ?? null;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      if (current === own) {
        return {
          ...draft,
          jumpTarget: null,
          jumpHostId: null,
          warnings: [
            ...draft.warnings,
            { kind: 'jumpHostCycle', target: draft.jumpTarget ?? '' },
          ],
        };
      }
      seen.add(current);
      current = targetOf.get(current) ?? null;
    }
    return draft;
  });
}

export type SshConfigImportResult = Readonly<{ hosts: SshHost[]; forwardCount: number }>;

/**
 * Writes the checked hosts, their jumps and their forwards as one transaction:
 * a config that fails partway leaves the store exactly as it was.
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
    let forwardCount = 0;
    for (const [index, draft] of plan.hosts.entries()) {
      const host = hosts[index];
      if (host === undefined) {
        continue;
      }
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
    results.push({ hosts, forwardCount });
  });
  const result = results[0];
  if (result === undefined) {
    throw new Error('ssh import: the transaction produced no result');
  }
  return result;
}
