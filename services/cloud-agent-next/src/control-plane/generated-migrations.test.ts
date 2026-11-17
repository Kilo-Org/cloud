import { describe, expect, it } from 'vitest';
import sessionMigrations from './session/drizzle/migrations.js';
import sandboxMigrations from './sandbox/drizzle/migrations.js';

describe('generated control-plane migration modules', () => {
  it.each([
    ['session', sessionMigrations],
    ['sandbox', sandboxMigrations],
  ] as const)('loads every %s journal entry once', (_name, generated) => {
    const keys = generated.journal.entries.map(entry => `m${String(entry.idx).padStart(4, '0')}`);
    expect(Object.keys(generated.migrations)).toEqual(keys);
    for (const migration of Object.values(generated.migrations)) {
      expect(migration).toBeTypeOf('string');
      expect(migration.length).toBeGreaterThan(0);
    }
  });
});
