import { MODE_SLUG_MAX_LENGTH } from '@kilocode/app-shared/organizations';
import { describe, expect, it } from 'vitest';

import {
  isOrgModeFormDirty,
  isOrgModeFormDraft,
  type OrgMode,
  orgModeConfigInput,
  orgModeFormSaveValues,
  type OrgModeFormTarget,
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

describe('validateOrgModeForm', () => {
  const existing = [
    { id: 'mode-1', slug: 'reviewer' },
    { id: 'mode-2', slug: 'docs' },
  ];
  const create: OrgModeFormTarget = { kind: 'create' };
  const updateMode1: OrgModeFormTarget = { kind: 'update', modeId: 'mode-1' };
  const updateMode2: OrgModeFormTarget = { kind: 'update', modeId: 'mode-2' };

  it('accepts a complete form', () => {
    expect(validateOrgModeForm(values({ slug: 'auditor' }), existing, create)).toEqual({});
  });

  it('names each missing required field', () => {
    expect(validateOrgModeForm(values({ slug: 'auditor', name: '  ' }), existing, create)).toEqual({
      name: 'nameRequired',
    });
    expect(
      validateOrgModeForm(values({ slug: 'auditor', roleDefinition: '' }), existing, create)
    ).toEqual({
      roleDefinition: 'roleRequired',
    });
    expect(validateOrgModeForm(values({ slug: '' }), existing, updateMode1)).toEqual({
      slug: 'identifierRequired',
    });
  });

  it('refuses a slug outside the letters-numbers-hyphens set', () => {
    expect(validateOrgModeForm(values({ slug: 'Reviewer' }), existing, create)).toEqual({
      slug: 'identifierInvalid',
    });
    expect(validateOrgModeForm(values({ slug: 'review_er' }), existing, create)).toEqual({
      slug: 'identifierInvalid',
    });
    // A character outside the set is the character-set refusal, however long the
    // text is: the set is checked first, so this never reads as merely too long.
    expect(
      validateOrgModeForm(
        values({ slug: `${'a'.repeat(MODE_SLUG_MAX_LENGTH)}A` }),
        existing,
        create
      )
    ).toEqual({ slug: 'identifierInvalid' });
  });

  it('refuses a slug past the server bound, and accepts one at it', () => {
    expect(
      validateOrgModeForm(values({ slug: 'a'.repeat(MODE_SLUG_MAX_LENGTH) }), existing, create)
    ).toEqual({});
    expect(
      validateOrgModeForm(values({ slug: 'a'.repeat(MODE_SLUG_MAX_LENGTH + 1) }), existing, create)
    ).toEqual({ slug: 'identifierTooLong' });
  });

  it('refuses a slug another mode holds, and keeps the edited mode its own', () => {
    expect(validateOrgModeForm(values({ slug: 'docs' }), existing, create)).toEqual({
      slug: 'identifierTaken',
    });
    expect(validateOrgModeForm(values({ slug: 'docs' }), existing, updateMode2)).toEqual({});
  });

  it('refuses a file restriction that is not a regular expression', () => {
    expect(
      validateOrgModeForm(
        values({ slug: 'auditor', groups: ['edit'], editFileRegex: '[unclosed' }),
        existing,
        create
      )
    ).toEqual({ editFileRegex: 'restrictionInvalid' });
    expect(
      validateOrgModeForm(
        values({ slug: 'auditor', groups: ['edit'], editFileRegex: '\\.md$' }),
        existing,
        create
      )
    ).toEqual({});
  });

  it('ignores a pattern while the edit group is off, as the config does', () => {
    expect(
      validateOrgModeForm(
        values({ slug: 'auditor', groups: ['read'], editFileRegex: '[unclosed' }),
        existing,
        create
      )
    ).toEqual({});
  });

  it('accepts a create whose identifier is empty when the name is present', () => {
    expect(validateOrgModeForm(values({ name: 'Auditor', slug: '' }), existing, create)).toEqual(
      {}
    );
  });

  it('reports only the missing name when a create has no name and no identifier', () => {
    // A create derives its identifier from the name, so an empty identifier is
    // never refused: the name is the one value it must supply.
    expect(validateOrgModeForm(values({ name: '  ', slug: '' }), existing, create)).toEqual({
      name: 'nameRequired',
    });
  });

  it('reports a cleared identifier on an update', () => {
    expect(validateOrgModeForm(values({ slug: '' }), existing, updateMode1)).toEqual({
      slug: 'identifierRequired',
    });
  });
});

describe('orgModeFormSaveValues', () => {
  it('derives an empty identifier from the name on create', () => {
    expect(
      orgModeFormSaveValues(values({ slug: '', name: 'Security Reviewer' }), 'create', []).slug
    ).toBe('security-reviewer');
  });

  it('derives the fallback past the slugs the organization holds on create', () => {
    expect(
      orgModeFormSaveValues(values({ slug: '', name: 'وضع' }), 'create', ['mode', 'mode-2']).slug
    ).toBe('mode-3');
  });

  it('derives the fallback for a fold-away name on create, empty slug or not', () => {
    expect(orgModeFormSaveValues(values({ slug: '', name: '###' }), 'create', []).slug).toBe(
      'mode'
    );
    expect(orgModeFormSaveValues(values({ slug: '', name: '###' }), 'create', ['mode']).slug).toBe(
      'mode-2'
    );
  });

  it('derives nothing from an empty name, so the save is refused as missing', () => {
    const saved = orgModeFormSaveValues(values({ slug: '', name: '' }), 'create', []);
    expect(saved.slug).toBe('');
    expect(saved.name).toBe('');
    expect(validateOrgModeForm(saved, [], { kind: 'create' })).toEqual({ name: 'nameRequired' });
  });

  it('keeps an identifier the person typed on create', () => {
    expect(orgModeFormSaveValues(values({ slug: 'auditor' }), 'create', []).slug).toBe('auditor');
  });

  it('derives an identifier the form accepts from a name past the bound', () => {
    // 99 characters: 25 three-letter words joined by hyphens. The fold is far
    // longer than the server's bound, so the derivation must clamp it, not the
    // form.
    const name = Array.from({ length: 25 }, () => 'abc').join('-');
    expect(name).toHaveLength(99);
    const saved = orgModeFormSaveValues(values({ slug: '', name }), 'create', []);

    expect(saved.slug.length).toBeLessThanOrEqual(MODE_SLUG_MAX_LENGTH);
    expect(saved.slug).toMatch(/^[a-z0-9-]+$/);
    expect(validateOrgModeForm(saved, [], { kind: 'create' })).toEqual({});
  });

  it('never derives one on update, so a cleared identifier is reported missing', () => {
    const cleared = values({ slug: '' });
    const saved = orgModeFormSaveValues(cleared, 'update', []);
    expect(saved.slug).toBe('');
    expect(validateOrgModeForm(saved, [], { kind: 'update', modeId: 'mode-2' })).toEqual({
      slug: 'identifierRequired',
    });
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

describe('isOrgModeFormDraft', () => {
  it('accepts the whole form, tool groups included', () => {
    expect(isOrgModeFormDraft(values())).toBe(true);
    expect(isOrgModeFormDraft(values({ groups: ['read', 'edit', 'mcp'] }))).toBe(true);
  });

  it('refuses another build’s value instead of coercing it', () => {
    expect(isOrgModeFormDraft({ ...values(), name: 42 })).toBe(false);
    expect(isOrgModeFormDraft({ ...values(), groups: ['read', 'deploy'] })).toBe(false);
    // A key this build does not know is another build's draft, not this one's.
    expect(isOrgModeFormDraft({ ...values(), extra: 'x' })).toBe(false);
    expect(isOrgModeFormDraft({ ...values(), groups: undefined })).toBe(false);
    expect(isOrgModeFormDraft(null)).toBe(false);
  });
});
