import {
  AWS_EGRESS_POLICY_REFRESH_MS,
  type AwsEgressPolicy,
} from '@kilocode/worker-utils/aws-egress';
import { isAllowedEgressUrl } from '@kilocode/worker-utils/egress-allowlist';
import { STANDARD_SCM_HOSTS } from '@kilocode/worker-utils/scm-capability-contract';
import { egressCredentialKey, ControlPlaneUnavailable } from './control-plane.js';

type Connection = { hostname: string; close: () => void };
type Entry = {
  token: string;
  controller: AbortController;
  policy?: AwsEgressPolicy;
  pending?: Promise<void>;
  refresh?: ReturnType<typeof setInterval>;
  expiry?: ReturnType<typeof setTimeout>;
  connections: Set<Connection>;
};
export type PolicyLease = {
  policy: () => AwsEgressPolicy;
  refresh: () => Promise<AwsEgressPolicy>;
  release: () => void;
};
export function permitted(policy: AwsEgressPolicy, hostname: string) {
  return (
    policy.allowlist === undefined ||
    isAllowedEgressUrl(new URL(`https://${hostname}/`), policy.allowlist)
  );
}
export function intercepted(policy: AwsEgressPolicy, hostname: string) {
  return policy.interceptedHosts.includes(hostname);
}

/** Each live connection closes at policy expiry, revocation, or a raw/intercepted transition. */
export function createPolicyRegistry(input: {
  load: (token: string, signal: AbortSignal) => Promise<AwsEgressPolicy>;
  now?: () => number;
  maxEntries?: number;
  maxConnectionsPerAllocation?: number;
}) {
  const entries = new Map<string, Entry>();
  const allocationCounts = new Map<string, number>();
  const now = input.now ?? Date.now;
  const maxEntries = input.maxEntries ?? 256;
  const maxConnections = input.maxConnectionsPerAllocation ?? 32;
  const allocation = (policy: AwsEgressPolicy) => `${policy.sandboxId}:${policy.allocationId}`;
  function remove(key: string, entry: Entry) {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    clearInterval(entry.refresh);
    clearTimeout(entry.expiry);
    entry.controller.abort();
    for (const connection of [...entry.connections]) connection.close();
  }
  async function refresh(key: string, entry: Entry) {
    if (entry.pending) return entry.pending;
    const request = (async () => {
      const policy = await input.load(entry.token, entry.controller.signal);
      if (entry.controller.signal.aborted || policy.validUntil <= now())
        throw new ControlPlaneUnavailable();
      const previous = entry.policy;
      entry.policy = policy;
      clearTimeout(entry.expiry);
      entry.expiry = setTimeout(() => remove(key, entry), Math.max(0, policy.validUntil - now()));
      for (const connection of [...entry.connections]) {
        if (
          !permitted(policy, connection.hostname) ||
          (previous &&
            (previous.allocationRef !== policy.allocationRef ||
              previous.audit !== policy.audit ||
              intercepted(previous, connection.hostname) !==
                intercepted(policy, connection.hostname)))
        )
          connection.close();
      }
    })();
    entry.pending = request;
    try {
      await request;
    } catch {
      if (!entry.policy || entry.policy.validUntil <= now()) remove(key, entry);
      throw new ControlPlaneUnavailable();
    } finally {
      if (entry.pending === request) entry.pending = undefined;
    }
  }
  return {
    async acquire(
      token: string,
      hostname: string,
      close: () => void,
      signal: AbortSignal
    ): Promise<PolicyLease> {
      signal.throwIfAborted();
      const key = egressCredentialKey(token);
      let entry = entries.get(key);
      if (entry?.policy && entry.policy.validUntil <= now()) {
        remove(key, entry);
        entry = undefined;
      }
      if (!entry) {
        if (entries.size >= maxEntries) {
          // Idle cache entries have no authority to consume capacity needed by a live connection.
          const idle = [...entries].find(([, value]) => !value.connections.size && !value.pending);
          if (idle) remove(...idle);
        }
        if (entries.size >= maxEntries) throw new ControlPlaneUnavailable();
        entry = { token, controller: new AbortController(), connections: new Set() };
        entries.set(key, entry);
      }
      // A new SCM connection must observe the current managed-host mode.
      if (!entry.policy || STANDARD_SCM_HOSTS.includes(hostname)) await refresh(key, entry);
      signal.throwIfAborted();
      if (entries.get(key) !== entry || !entry.policy || entry.policy.validUntil <= now())
        throw new ControlPlaneUnavailable();
      const allocationKey = allocation(entry.policy);
      if ((allocationCounts.get(allocationKey) ?? 0) >= maxConnections)
        throw new ControlPlaneUnavailable();
      const connection = { hostname, close };
      entry.connections.add(connection);
      allocationCounts.set(allocationKey, (allocationCounts.get(allocationKey) ?? 0) + 1);
      const selected = entry;
      if (!entry.refresh)
        entry.refresh = setInterval(() => {
          void refresh(key, selected).catch(() => {
            /* Existing sockets close at the last accepted deadline. */
          });
        }, AWS_EGRESS_POLICY_REFRESH_MS);
      let released = false;
      return {
        policy: () => {
          if (
            released ||
            entries.get(key) !== selected ||
            !selected.policy ||
            selected.policy.validUntil <= now()
          )
            throw new ControlPlaneUnavailable();
          return selected.policy;
        },
        async refresh() {
          await refresh(key, selected);
          if (released || entries.get(key) !== selected || !selected.policy)
            throw new ControlPlaneUnavailable();
          return selected.policy;
        },
        release() {
          if (released) return;
          released = true;
          selected.connections.delete(connection);
          const count = (allocationCounts.get(allocationKey) ?? 1) - 1;
          if (count) allocationCounts.set(allocationKey, count);
          else allocationCounts.delete(allocationKey);
          if (!selected.connections.size) {
            clearInterval(selected.refresh);
            selected.refresh = undefined;
          }
        },
      };
    },
    close() {
      for (const [key, entry] of entries) remove(key, entry);
    },
  };
}
