import {
  PERMISSION_TOOLS,
  mergePermissions,
  readDisabledTools,
  readWholeToolAction,
  type PermissionTool,
} from './agent-permissions';

/** The tool set an edit ends with after turning `tool` off and back on. */
function toggledTwice(loaded: ReadonlySet<PermissionTool>, tool: PermissionTool) {
  const next = new Set(loaded);
  next.add(tool);
  next.delete(tool);
  return next;
}

describe('readDisabledTools', () => {
  it('marks only tools whose stored rule is a plain denial', () => {
    const disabled = readDisabledTools({
      edit: 'deny',
      bash: { 'git *': 'allow', '*': 'ask' },
      read: 'ask',
      grep: 'allow',
    });

    expect([...disabled]).toEqual(['edit']);
  });

  it('treats an absent permission or an action-only permission as nothing disabled', () => {
    expect(readDisabledTools(undefined).size).toBe(0);
    expect(readDisabledTools('allow').size).toBe(0);
    expect(readDisabledTools('ask').size).toBe(0);
  });

  it('treats a whole-agent denial as every tool denied', () => {
    expect([...readDisabledTools('deny')]).toEqual([...PERMISSION_TOOLS]);
  });
});

describe('readWholeToolAction', () => {
  it('reports the stored single-rule action and nothing for a tool map', () => {
    expect(readWholeToolAction('deny')).toBe('deny');
    expect(readWholeToolAction('ask')).toBe('ask');
    expect(readWholeToolAction({ edit: 'deny' })).toBeUndefined();
    expect(readWholeToolAction(undefined)).toBeUndefined();
  });
});

describe('mergePermissions', () => {
  it('keeps a stored ask rule when the tool is not touched', () => {
    const loaded = { read: 'ask', edit: 'deny' } as const;

    expect(mergePermissions(loaded, new Set<PermissionTool>(['edit']))).toEqual({
      read: 'ask',
      edit: 'deny',
    });
  });

  it('keeps a stored ask rule after an off-then-on toggle', () => {
    const loaded = { read: 'ask' } as const;
    const after = toggledTwice(readDisabledTools(loaded), 'read');

    expect(after.has('read')).toBe(false);
    expect(mergePermissions(loaded, after)).toEqual({ read: 'ask' });
  });

  it('keeps a stored per-pattern rule after an off-then-on toggle', () => {
    const loaded = { bash: { 'git *': 'allow', '*': 'ask' } } as const;
    const after = toggledTwice(readDisabledTools(loaded), 'bash');

    expect(mergePermissions(loaded, after)).toEqual({
      bash: { 'git *': 'allow', '*': 'ask' },
    });
  });

  it('drops a stored denial when the user turns the tool back on', () => {
    const loaded = { edit: 'deny', glob: 'deny' } as const;

    expect(mergePermissions(loaded, new Set<PermissionTool>(['edit']))).toEqual({
      edit: 'deny',
    });
    expect(mergePermissions(loaded, new Set<PermissionTool>())).toBeUndefined();
  });

  it('denies a tool the user turns off and keeps the rest of the map', () => {
    const loaded = { read: 'ask', 'not a tool': 'deny' } as const;

    expect(mergePermissions(loaded, new Set<PermissionTool>(['bash']))).toEqual({
      read: 'ask',
      'not a tool': 'deny',
      bash: 'deny',
    });
  });

  it('keeps unrelated keys, the null sentinel and unknown tool keys untouched', () => {
    const loaded = { external_directory: null, webfetch: 'allow', mcp: { '*': 'ask' } } as const;

    expect(mergePermissions(loaded, new Set<PermissionTool>())).toEqual(loaded);
  });

  it('returns undefined when no rule remains', () => {
    expect(mergePermissions(undefined, new Set<PermissionTool>())).toBeUndefined();
    expect(mergePermissions({ edit: 'deny' }, new Set<PermissionTool>())).toBeUndefined();
  });

  it('returns a whole-agent action unchanged instead of rewriting it per tool', () => {
    expect(mergePermissions('deny', new Set<PermissionTool>(['read']))).toBe('deny');
    expect(mergePermissions('ask', new Set<PermissionTool>())).toBe('ask');
  });
});
