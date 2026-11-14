import { ORGANIZATION_NAME_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { OrganizationNameSchema } from './organization-types';

describe('OrganizationNameSchema', () => {
  it('rejects a name made only of zero-width spaces', () => {
    const result = OrganizationNameSchema.safeParse('\u200B\u200B\u200B');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Organization name is required');
  });

  it('rejects an empty name', () => {
    const result = OrganizationNameSchema.safeParse('');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Organization name is required');
  });

  it('rejects a name made only of unpaired surrogates', () => {
    const result = OrganizationNameSchema.safeParse('\uD800\uD800');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Organization name is required');
  });

  it('rejects whitespace-only names', () => {
    const result = OrganizationNameSchema.safeParse('   ');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Organization name is required');
  });

  it('trims around a name and keeps interior zero-width characters', () => {
    const result = OrganizationNameSchema.safeParse('\u200B\u200BName');

    expect(result.success).toBe(true);
    expect(result.data).toBe('\u200B\u200BName');
  });

  it('trims surrounding whitespace', () => {
    const result = OrganizationNameSchema.safeParse('  Acme  ');

    expect(result.success).toBe(true);
    expect(result.data).toBe('Acme');
  });

  it('accepts a name at the length limit', () => {
    const result = OrganizationNameSchema.safeParse('a'.repeat(ORGANIZATION_NAME_MAX_LENGTH));

    expect(result.success).toBe(true);
  });

  it('rejects a name over the length limit', () => {
    const result = OrganizationNameSchema.safeParse('a'.repeat(ORGANIZATION_NAME_MAX_LENGTH + 1));

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      `Organization name must be ${ORGANIZATION_NAME_MAX_LENGTH} characters or fewer`
    );
  });
});
