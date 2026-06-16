import { describe, expect, it } from '@jest/globals';
import { OrganizationSettingsSchema } from './schema-types';

describe('OrganizationSettingsSchema org_auto_model', () => {
  it('accepts bounded route maps and a fallback model', () => {
    const result = OrganizationSettingsSchema.safeParse({
      org_auto_model: {
        routes: {
          code: 'anthropic/claude-sonnet-4.5',
          plan: 'kilo-auto/frontier',
        },
        fallback_model: 'kilo-auto/balanced',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects Organization Auto self-targets', () => {
    const result = OrganizationSettingsSchema.safeParse({
      org_auto_model: {
        routes: { code: 'kilo-auto/org' },
        fallback_model: 'kilo-auto/balanced',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects route maps with more than 100 routes', () => {
    const routes = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`mode-${index}`, 'kilo-auto/balanced'])
    );
    const result = OrganizationSettingsSchema.safeParse({
      org_auto_model: {
        routes,
        fallback_model: 'kilo-auto/balanced',
      },
    });

    expect(result.success).toBe(false);
  });
});
