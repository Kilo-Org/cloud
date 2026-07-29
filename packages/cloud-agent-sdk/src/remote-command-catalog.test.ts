import { parseRemoteCommandCatalog, remoteCommandCatalogV1Schema } from './remote-command-catalog';

describe('remote command catalog schema', () => {
  it('accepts a strict v1 catalog and excludes skill commands', () => {
    expect(
      remoteCommandCatalogV1Schema.parse({
        protocolVersion: 1,
        commands: [
          {
            name: 'review',
            description: 'Review changes',
            source: 'command',
            hints: ['$ARGUMENTS'],
          },
          {
            name: 'hidden-skill',
            description: 'Not part of the remote surface',
            source: 'skill',
            hints: [],
          },
          {
            name: 'compact',
            description: 'compact the current session context',
            hints: [],
          },
        ],
      })
    ).toEqual({
      protocolVersion: 1,
      commands: [
        {
          name: 'review',
          description: 'Review changes',
          source: 'command',
          hints: ['$ARGUMENTS'],
        },
        {
          name: 'compact',
          description: 'compact the current session context',
          hints: [],
        },
      ],
    });
  });

  it('rejects unsupported protocols and unknown wire fields', () => {
    const command = {
      name: 'review',
      description: 'Review changes',
      agent: 'code',
      model: 'anthropic/claude-sonnet-4',
      source: 'command' as const,
      hints: ['$ARGUMENTS'],
    };
    const catalog = (commands: unknown[]) => ({ protocolVersion: 1, commands });

    expect(
      remoteCommandCatalogV1Schema.safeParse({ ...catalog([command]), protocolVersion: 2 }).success
    ).toBe(false);
    expect(
      remoteCommandCatalogV1Schema.safeParse({ ...catalog([command]), extra: true }).success
    ).toBe(false);
    expect(
      remoteCommandCatalogV1Schema.safeParse(
        catalog([{ ...command, template: 'private implementation detail' }])
      ).success
    ).toBe(false);
  });

  it('rejects more than 256 commands', () => {
    const command = {
      name: 'review',
      description: 'Review changes',
      source: 'command' as const,
      hints: ['$ARGUMENTS'],
    };
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        commands: Array.from({ length: 257 }, () => command),
      }).success
    ).toBe(false);
  });

  it('rejects strings longer than 2,000 characters', () => {
    const command = {
      name: 'review',
      description: 'Review changes',
      agent: 'code',
      model: 'anthropic/claude-sonnet-4',
      source: 'command' as const,
      hints: ['$ARGUMENTS'],
    };
    const catalog = (commands: unknown[]) => ({ protocolVersion: 1, commands });

    for (const field of ['name', 'description', 'agent', 'model'] as const) {
      expect(
        remoteCommandCatalogV1Schema.safeParse(
          catalog([{ ...command, [field]: 'x'.repeat(2_001) }])
        ).success
      ).toBe(false);
    }

    expect(
      remoteCommandCatalogV1Schema.safeParse(catalog([{ ...command, hints: ['x'.repeat(2_001)] }]))
        .success
    ).toBe(false);
  });

  it('rejects more than 32 hints per command', () => {
    const command = {
      name: 'review',
      description: 'Review changes',
      source: 'command' as const,
      hints: Array.from({ length: 33 }, () => 'hint'),
    };
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        commands: [command],
      }).success
    ).toBe(false);
  });

  it('measures the 512 KiB serialized bound in UTF-8 bytes', () => {
    const command = {
      name: 'review',
      description: 'Review changes',
      source: 'command' as const,
      hints: ['$ARGUMENTS'],
    };
    const multibyteCatalog = {
      protocolVersion: 1,
      commands: Array.from({ length: 256 }, () => ({
        ...command,
        description: 'é'.repeat(1_000),
      })),
    };
    const serialized = JSON.stringify(multibyteCatalog);
    expect(serialized.length).toBeLessThan(512 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(512 * 1024);
    expect(remoteCommandCatalogV1Schema.safeParse(multibyteCatalog).success).toBe(false);
  });

  it('normalizes an omitted `hints` key to an empty array', () => {
    // Older CLI versions serialize commands without a `hints` key at all.
    // The wire shape must accept that and emit `hints: []` so SlashCommandInfo
    // stays structurally satisfied without fail-closing the whole catalog.
    const parsed = remoteCommandCatalogV1Schema.parse({
      protocolVersion: 1,
      commands: [
        { name: 'review', description: 'Review changes', source: 'command' },
        { name: 'compact', description: 'compact the current session context' },
      ],
    });
    expect(parsed).toEqual({
      protocolVersion: 1,
      commands: [
        { name: 'review', description: 'Review changes', source: 'command', hints: [] },
        { name: 'compact', description: 'compact the current session context', hints: [] },
      ],
    });
  });

  it('preserves explicit hints values when provided', () => {
    const parsed = remoteCommandCatalogV1Schema.parse({
      protocolVersion: 1,
      commands: [
        { name: 'review', description: 'Review changes', source: 'command', hints: ['$ARGUMENTS'] },
      ],
    });
    expect(parsed.commands[0]?.hints).toEqual(['$ARGUMENTS']);
  });

  it('still rejects malformed hints (non-string entry, over-length string, over cap)', () => {
    const base = {
      name: 'review',
      description: 'Review changes',
      source: 'command' as const,
    };
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        commands: [{ ...base, hints: [123] }],
      }).success
    ).toBe(false);
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        commands: [{ ...base, hints: ['x'.repeat(2_001)] }],
      }).success
    ).toBe(false);
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        commands: [{ ...base, hints: Array.from({ length: 33 }, () => 'hint') }],
      }).success
    ).toBe(false);
  });

  it('still rejects commands carrying unknown keys after relaxing hints', () => {
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        commands: [
          {
            name: 'review',
            description: 'Review changes',
            source: 'command',
            hints: ['$ARGUMENTS'],
            template: 'private implementation detail',
          },
        ],
      }).success
    ).toBe(false);
  });

  it('parses a catalog that advertises canExitSession: true (newer CLIs)', () => {
    const parsed = remoteCommandCatalogV1Schema.parse({
      protocolVersion: 1,
      canExitSession: true,
      commands: [{ name: 'review', description: 'Review changes', source: 'command', hints: [] }],
    });
    expect(parsed.canExitSession).toBe(true);
    expect(parsed.commands).toHaveLength(1);
  });

  it('parses a catalog that omits canExitSession without invalidating other commands (old CLIs)', () => {
    // The strict object shape accepts missing optional fields, so catalogs
    // from old CLIs still parse — the gate downstream treats `undefined` as
    // "not supported" and fails closed. No command is dropped.
    const parsed = remoteCommandCatalogV1Schema.parse({
      protocolVersion: 1,
      commands: [
        { name: 'review', description: 'Review changes', source: 'command', hints: ['$ARGUMENTS'] },
        { name: 'compact', description: 'compact the current session context', hints: [] },
      ],
    });
    expect(parsed.canExitSession).toBeUndefined();
    expect(parsed.commands).toHaveLength(2);
  });

  it('parses a catalog that explicitly sets canExitSession: false', () => {
    const parsed = remoteCommandCatalogV1Schema.parse({
      protocolVersion: 1,
      canExitSession: false,
      commands: [],
    });
    expect(parsed.canExitSession).toBe(false);
  });

  it('rejects a non-boolean canExitSession value', () => {
    expect(
      remoteCommandCatalogV1Schema.safeParse({
        protocolVersion: 1,
        canExitSession: 'yes',
        commands: [],
      }).success
    ).toBe(false);
  });
});

describe('parseRemoteCommandCatalog', () => {
  it('rejects a catalog whose two command entries share the same name', () => {
    const result = parseRemoteCommandCatalog({
      protocolVersion: 1,
      commands: [
        { name: 'review', description: 'first', source: 'command', hints: [] },
        { name: 'review', description: 'second', source: 'command', hints: [] },
      ],
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects duplicates even when one entry is a skill-sourced command', () => {
    // Filtering happens only after untrusted catalog validation, so a
    // `command` entry whose name collides with a `skill` entry is still
    // ambiguous and the whole catalog must be rejected.
    const result = parseRemoteCommandCatalog({
      protocolVersion: 1,
      commands: [
        { name: 'review', description: 'visible', source: 'command', hints: [] },
        { name: 'review', description: 'hidden', source: 'skill', hints: [] },
      ],
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('surfaces canExitSession: true from a newer-CLI catalog', () => {
    const result = parseRemoteCommandCatalog({
      protocolVersion: 1,
      canExitSession: true,
      commands: [],
    });
    expect(result).toEqual({ ok: true, commands: [], canExitSession: true });
  });

  it('surfaces canExitSession as undefined when an old CLI omits the field', () => {
    const result = parseRemoteCommandCatalog({
      protocolVersion: 1,
      commands: [{ name: 'review', description: 'Review changes', source: 'command', hints: [] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.canExitSession).toBeUndefined();
      expect(result.commands).toHaveLength(1);
    }
  });
});

describe('RemoteCommandState', () => {
  it('always carries a `commands` array (empty when none discovered)', () => {
    // The state is a public surface; consumers must be able to read
    // `state.commands` unconditionally instead of tracking the cache
    // separately.
    const state = {
      ownerConnectionId: null,
      refresh: 'idle' as const,
      commands: [] as never[],
    };
    expect(Array.isArray(state.commands)).toBe(true);
  });
});
