export type SetupRunConfigView = {
  script: string;
  plainVars: Record<string, string>;
  secretKeys: string[];
  sandboxAllocation: string | null;
  egressMode: string | null;
  egressAllowlist: string[];
  requiredHosts: string[];
  repositories: string[];
};

export type SetupRunDiffEgress = {
  mode: 'allowlist' | 'unrestricted';
  allowlist: string[];
};

export type SetupRunDiff = {
  scriptChanged: boolean;
  scriptBefore: string;
  scriptAfter: string;
  plainVarsAdded: string[];
  plainVarsRemoved: string[];
  plainVarsChanged: string[];
  secretKeysAdded: string[];
  secretKeysRemoved: string[];
  sandboxAllocation: { before: string | null; after: string | null } | null;
  egress: { before: SetupRunDiffEgress; after: SetupRunDiffEgress } | null;
  requiredHostsAdded: string[];
  requiredHostsRemoved: string[];
  repositoriesAdded: string[];
  repositoriesRemoved: string[];
};

const EMPTY_CONFIG_VIEW: SetupRunConfigView = {
  script: '',
  plainVars: {},
  secretKeys: [],
  sandboxAllocation: null,
  egressMode: null,
  egressAllowlist: [],
  requiredHosts: [],
  repositories: [],
};

function added(before: string[], after: string[]): string[] {
  const existing = new Set(before);
  return after.filter(value => !existing.has(value));
}

function removed(before: string[], after: string[]): string[] {
  const retained = new Set(after);
  return before.filter(value => !retained.has(value));
}

function egressView(config: SetupRunConfigView): SetupRunDiffEgress {
  const mode = config.egressMode === 'allowlist' ? 'allowlist' : 'unrestricted';
  return {
    mode,
    allowlist: mode === 'allowlist' ? [...new Set(config.egressAllowlist)].sort() : [],
  };
}

function egressChanged(before: SetupRunDiffEgress, after: SetupRunDiffEgress): boolean {
  return (
    before.mode !== after.mode ||
    before.allowlist.length !== after.allowlist.length ||
    before.allowlist.some((host, index) => host !== after.allowlist[index])
  );
}

export function buildSetupRunDiff(
  beforeConfig: SetupRunConfigView | null,
  afterConfig: SetupRunConfigView
): SetupRunDiff {
  const before = beforeConfig ?? EMPTY_CONFIG_VIEW;

  const beforeVars = Object.keys(before.plainVars);
  const afterVars = Object.keys(afterConfig.plainVars);
  const beforeVarSet = new Set(beforeVars);
  const afterVarSet = new Set(afterVars);

  const beforeEgress = egressView(before);
  const afterEgress = egressView(afterConfig);

  return {
    scriptChanged: before.script !== afterConfig.script,
    scriptBefore: before.script,
    scriptAfter: afterConfig.script,
    plainVarsAdded: afterVars.filter(key => !beforeVarSet.has(key)),
    plainVarsRemoved: beforeVars.filter(key => !afterVarSet.has(key)),
    plainVarsChanged: afterVars.filter(
      key => beforeVarSet.has(key) && before.plainVars[key] !== afterConfig.plainVars[key]
    ),
    secretKeysAdded: added(before.secretKeys, afterConfig.secretKeys),
    secretKeysRemoved: removed(before.secretKeys, afterConfig.secretKeys),
    sandboxAllocation:
      before.sandboxAllocation === afterConfig.sandboxAllocation
        ? null
        : { before: before.sandboxAllocation, after: afterConfig.sandboxAllocation },
    egress: egressChanged(beforeEgress, afterEgress)
      ? { before: beforeEgress, after: afterEgress }
      : null,
    requiredHostsAdded: added(before.requiredHosts, afterConfig.requiredHosts),
    requiredHostsRemoved: removed(before.requiredHosts, afterConfig.requiredHosts),
    repositoriesAdded: added(before.repositories, afterConfig.repositories),
    repositoriesRemoved: removed(before.repositories, afterConfig.repositories),
  };
}
