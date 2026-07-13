import { remoteCommandCatalogV1Schema } from './schemas';

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

  const command = {
    name: 'review',
    description: 'Review changes',
    agent: 'code',
    model: 'anthropic/claude-sonnet-4',
    source: 'command' as const,
    hints: ['$ARGUMENTS'],
  };
  const catalog = (commands: unknown[]) => ({ protocolVersion: 1, commands });

  it('rejects unsupported protocols and unknown wire fields', () => {
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
    expect(
      remoteCommandCatalogV1Schema.safeParse(catalog(Array.from({ length: 257 }, () => command)))
        .success
    ).toBe(false);
  });

  it('rejects strings longer than 2,000 characters', () => {
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
    expect(
      remoteCommandCatalogV1Schema.safeParse(
        catalog([{ ...command, hints: Array.from({ length: 33 }, () => 'hint') }])
      ).success
    ).toBe(false);
  });

  it('measures the 512 KiB serialized bound in UTF-8 bytes', () => {
    const multibyteCatalog = catalog(
      Array.from({ length: 256 }, () => ({
        ...command,
        description: 'é'.repeat(1_000),
      }))
    );
    const serialized = JSON.stringify(multibyteCatalog);
    expect(serialized.length).toBeLessThan(512 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(512 * 1024);
    expect(remoteCommandCatalogV1Schema.safeParse(multibyteCatalog).success).toBe(false);
  });
});
