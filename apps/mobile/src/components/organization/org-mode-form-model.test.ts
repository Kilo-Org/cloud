import { describe, expect, it } from 'vitest';

import {
  isOrgModeFormDirty,
  modeSlugFromName,
  type OrgMode,
  orgModeConfigInput,
  orgModeFormSaveValues,
  orgModeFormValues,
  type OrgModeFormValues,
  validateOrgModeForm,
} from '@/components/organization/org-mode-form-model';

function values(overrides: Partial<OrgModeFormValues> = {}): OrgModeFormValues {
  return {
    name: 'Reviewer',
    slug: 'reviewer',
    roleDefinition: 'You review changes.',
    description: '',
    whenToUse: '',
    customInstructions: '',
    groups: ['read'],
    editFileRegex: '',
    editRestrictionLabel: '',
    ...overrides,
  };
}

function storedMode(overrides: Partial<OrgMode['config']> = {}): OrgMode {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    organization_id: '22222222-2222-2222-2222-222222222222',
    name: 'Architect',
    slug: 'architect',
    created_by: 'user_1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    config: {
      roleDefinition: 'You plan.',
      description: 'Plan first',
      whenToUse: 'Before implementation',
      customInstructions: 'Keep it short',
      groups: ['read', ['edit', { fileRegex: '\\.md$', description: 'Markdown only' }], 'browser'],
      ...overrides,
    },
  };
}

describe('modeSlugFromName', () => {
  it('folds a name into lowercase words joined by one hyphen', () => {
    expect(modeSlugFromName('Security Reviewer')).toBe('security-reviewer');
    expect(modeSlugFromName('  Data   Analyst!  ')).toBe('data-analyst');
  });

  it('leaves no leading or trailing hyphen', () => {
    expect(modeSlugFromName('-Docs-')).toBe('docs');
    expect(modeSlugFromName('###')).toBe('');
  });
});

describe('validateOrgModeForm', () => {
  const existing = [
    { id: 'mode-1', slug: 'reviewer' },
    { id: 'mode-2', slug: 'docs' },
  ];

  it('accepts a complete form', () => {
    expect(validateOrgModeForm(values({ slug: 'auditor' }), existing)).toEqual({});
  });

  it('names each missing required field', () => {
    expect(validateOrgModeForm(values({ slug: 'auditor', name: '  ' }), existing)).toEqual({
      name: 'nameRequired',
    });
    expect(validateOrgModeForm(values({ slug: 'auditor', roleDefinition: '' }), existing)).toEqual({
      roleDefinition: 'roleRequired',
    });
    expect(validateOrgModeForm(values({ slug: '' }), existing)).toEqual({
      slug: 'identifierRequired',
    });
  });

  it('refuses a slug outside the letters-numbers-hyphens set', () => {
    expect(validateOrgModeForm(values({ slug: 'Reviewer' }), existing)).toEqual({
      slug: 'identifierInvalid',
    });
    expect(validateOrgModeForm(values({ slug: 'review_er' }), existing)).toEqual({
      slug: 'identifierInvalid',
    });
    expect(validateOrgModeForm(values({ slug: 'a'.repeat(51) }), existing)).toEqual({
      slug: 'identifierInvalid',
    });
  });

  it('refuses a slug another mode holds, and keeps the edited mode its own', () => {
    expect(validateOrgModeForm(values({ slug: 'docs' }), existing)).toEqual({
      slug: 'identifierTaken',
    });
    expect(validateOrgModeForm(values({ slug: 'docs' }), existing, 'mode-2')).toEqual({});
  });

  it('refuses a file restriction that is not a regular expression', () => {
    expect(
      validateOrgModeForm(
        values({ slug: 'auditor', groups: ['edit'], editFileRegex: '[unclosed' }),
        existing
      )
    ).toEqual({ editFileRegex: 'restrictionInvalid' });
    expect(
      validateOrgModeForm(
        values({ slug: 'auditor', groups: ['edit'], editFileRegex: '\\.md$' }),
        existing
      )
    ).toEqual({});
  });

  it('ignores a pattern while the edit group is off, as the config does', () => {
    expect(
      validateOrgModeForm(
        values({ slug: 'auditor', groups: ['read'], editFileRegex: '[unclosed' }),
        existing
      )
    ).toEqual({});
  });
});

describe('orgModeFormSaveValues', () => {
  it('derives an empty identifier from the name on create', () => {
    expect(
      orgModeFormSaveValues(values({ slug: '', name: 'Security Reviewer' }), 'create').slug
    ).toBe('security-reviewer');
  });

  it('keeps an identifier the person typed on create', () => {
    expect(orgModeFormSaveValues(values({ slug: 'auditor' }), 'create').slug).toBe('auditor');
  });

  it('never derives one on update, so a cleared identifier is reported missing', () => {
    const cleared = values({ slug: '' });
    const saved = orgModeFormSaveValues(cleared, 'update');
    expect(saved.slug).toBe('');
    expect(validateOrgModeForm(saved, [])).toEqual({ slug: 'identifierRequired' });
  });
});

describe('isOrgModeFormDirty', () => {
  it('treats any text as a change on a create form', () => {
    expect(isOrgModeFormDirty(values(), null)).toBe(true);
    expect(isOrgModeFormDirty(values({ name: '', slug: '', roleDefinition: '' }), null)).toBe(
      false
    );
  });

  it('compares an edit form against the mode it opened with', () => {
    const initial = values();
    expect(isOrgModeFormDirty(values(), initial)).toBe(false);
    expect(isOrgModeFormDirty(values({ name: 'Reviewer two' }), initial)).toBe(true);
  });

  it('reads the tool groups as a set, so their order is not a change', () => {
    const initial = values({ groups: ['read', 'edit'] });
    expect(isOrgModeFormDirty(values({ groups: ['edit', 'read'] }), initial)).toBe(false);
    expect(isOrgModeFormDirty(values({ groups: ['edit'] }), initial)).toBe(true);
  });
});

describe('orgModeFormValues', () => {
  it('reads a stored config into the form, keeping the edit restriction', () => {
    expect(orgModeFormValues(storedMode())).toEqual({
      name: 'Architect',
      slug: 'architect',
      roleDefinition: 'You plan.',
      description: 'Plan first',
      whenToUse: 'Before implementation',
      customInstructions: 'Keep it short',
      groups: ['read', 'edit', 'browser'],
      editFileRegex: '\\.md$',
      editRestrictionLabel: 'Markdown only',
    });
  });

  it('fills empty text for a config that omits its optional fields', () => {
    const mode = storedMode({
      description: undefined,
      whenToUse: undefined,
      customInstructions: undefined,
      groups: [],
    });
    expect(orgModeFormValues(mode)).toMatchObject({
      description: '',
      whenToUse: '',
      customInstructions: '',
      groups: [],
      editFileRegex: '',
    });
  });
});

describe('orgModeConfigInput', () => {
  it('omits optional text the person left empty on create', () => {
    expect(orgModeConfigInput(values({ groups: [] }), 'create')).toEqual({
      roleDefinition: 'You review changes.',
      groups: [],
    });
  });

  it('sends empty optional text on update so clearing a field reaches the server', () => {
    expect(
      orgModeConfigInput(
        values({ groups: [], description: '', whenToUse: ' ', customInstructions: '' }),
        'update'
      )
    ).toEqual({
      roleDefinition: 'You review changes.',
      description: '',
      whenToUse: '',
      customInstructions: '',
      groups: [],
    });
  });

  it('trims the text it sends', () => {
    expect(
      orgModeConfigInput(
        values({ name: ' x ', roleDefinition: '  Review.  ', description: ' Draft ' }),
        'create'
      )
    ).toEqual({
      roleDefinition: 'Review.',
      description: 'Draft',
      groups: ['read'],
    });
  });

  it('rebuilds the edit restriction as the group tuple the server stores', () => {
    expect(
      orgModeConfigInput(
        values({ groups: ['edit', 'read'], editFileRegex: '\\.md$', editRestrictionLabel: 'Docs' }),
        'create'
      ).groups
    ).toEqual(['read', ['edit', { fileRegex: '\\.md$', description: 'Docs' }]]);
  });

  it('drops the restriction with the group that disables it', () => {
    expect(
      orgModeConfigInput(values({ groups: [], editFileRegex: '\\.md$' }), 'create').groups
    ).toEqual([]);
  });
});
