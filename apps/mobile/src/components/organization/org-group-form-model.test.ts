import { describe, expect, it } from 'vitest';

import {
  filterOrgGroupMembers,
  isOrgGroupFormDirty,
  isOrgGroupFormDraft,
  ORG_GROUP_NAME_MAX_LENGTH,
  orgGroupFormExit,
  orgGroupNameError,
  selectOrgGroupMemberPickerState,
  toggleOrgGroupMember,
  toggleOrgGroupMembers,
} from '@/components/organization/org-group-form-model';

describe('orgGroupNameError', () => {
  it('requires a name that is not only whitespace', () => {
    expect(orgGroupNameError('')).toBe('required');
    expect(orgGroupNameError('   ')).toBe('required');
  });

  it('keeps the name inside the server bound', () => {
    expect(orgGroupNameError('Engineering')).toBeNull();
    expect(orgGroupNameError('a'.repeat(ORG_GROUP_NAME_MAX_LENGTH))).toBeNull();
    expect(orgGroupNameError('a'.repeat(ORG_GROUP_NAME_MAX_LENGTH + 1))).toBe('tooLong');
  });
});

describe('toggleOrgGroupMember', () => {
  it('adds a member once, keeping the selection order', () => {
    expect(toggleOrgGroupMember(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleOrgGroupMember(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
  });

  it('removes a member', () => {
    expect(toggleOrgGroupMember(['a', 'b'], 'a', false)).toEqual(['b']);
  });
});

describe('toggleOrgGroupMembers', () => {
  it('adds every visible member and keeps the ones the filter hides', () => {
    expect(toggleOrgGroupMembers(['hidden'], ['a', 'b'], true)).toEqual(['hidden', 'a', 'b']);
  });

  it('clears every visible member and keeps the ones the filter hides', () => {
    expect(toggleOrgGroupMembers(['hidden', 'a', 'b'], ['a', 'b'], false)).toEqual(['hidden']);
  });

  it('returns the same selection when everyone visible is already selected', () => {
    expect(toggleOrgGroupMembers(['a', 'b'], ['a', 'b'], true)).toEqual(['a', 'b']);
  });
});

describe('filterOrgGroupMembers', () => {
  const ANAIS = {
    id: 'a',
    name: 'Anaís Núñez-Ferreira de la Concepción',
    email: 'anais@example.com',
  };

  it('keeps an accented member for an unaccented query', () => {
    expect(filterOrgGroupMembers([ANAIS], 'anais')).toEqual([ANAIS]);
  });

  it('keeps an accented member for the accented query', () => {
    expect(filterOrgGroupMembers([ANAIS], 'anaís')).toEqual([ANAIS]);
  });

  it('matches on the email alone', () => {
    expect(filterOrgGroupMembers([ANAIS], 'example.com')).toEqual([ANAIS]);
  });

  it('ignores the query case', () => {
    expect(filterOrgGroupMembers([ANAIS], 'ANAIS')).toEqual([ANAIS]);
  });

  it('returns the whole list in order for a blank or whitespace-only query', () => {
    const members = [ANAIS, { id: 'b', name: 'Béla', email: 'bela@example.com' }];
    expect(filterOrgGroupMembers(members, '')).toEqual(members);
    expect(filterOrgGroupMembers(members, '   ')).toEqual(members);
  });

  it('returns an empty list when no member matches', () => {
    expect(filterOrgGroupMembers([ANAIS], 'zzz')).toEqual([]);
  });

  it('keeps the input order when two of three members match', () => {
    const members = [
      { id: 'c', name: 'Céline Marchand', email: 'celine@example.com' },
      { id: 'b', name: 'Béla Núñez', email: 'bela@example.com' },
      { id: 'a', name: 'Anaís Núñez-Ferreira de la Concepción', email: 'anais@example.com' },
    ];
    expect(filterOrgGroupMembers(members, 'nunez')).toEqual([members[1], members[2]]);
  });
});

describe('selectOrgGroupMemberPickerState', () => {
  const loaded = { isPending: false, isError: false, hasData: true };

  it('reports a pending fetch as loading, never as an empty search', () => {
    expect(
      selectOrgGroupMemberPickerState({ isPending: true, isError: false, hasData: false }, 0)
    ).toEqual({ kind: 'loading' });
  });

  it('reports a failed fetch with no data as an error', () => {
    expect(
      selectOrgGroupMemberPickerState({ isPending: false, isError: true, hasData: false }, 0)
    ).toEqual({ kind: 'error' });
  });

  it('keeps the loaded members when a later fetch fails', () => {
    expect(selectOrgGroupMemberPickerState({ ...loaded, isError: true }, 2)).toEqual({
      kind: 'list',
    });
  });

  it('separates an empty search result from the query states', () => {
    expect(selectOrgGroupMemberPickerState(loaded, 0)).toEqual({ kind: 'empty' });
    expect(selectOrgGroupMemberPickerState(loaded, 1)).toEqual({ kind: 'list' });
  });
});

describe('isOrgGroupFormDirty', () => {
  it('treats any typed text or selected member as a change on a create form', () => {
    expect(isOrgGroupFormDirty({ name: '', description: '', memberIds: [] }, null)).toBe(false);
    expect(isOrgGroupFormDirty({ name: 'Design', description: '', memberIds: [] }, null)).toBe(
      true
    );
    expect(isOrgGroupFormDirty({ name: '', description: '', memberIds: ['u1'] }, null)).toBe(true);
  });

  it('compares an edit form against the group it opened with', () => {
    const initial = { name: 'Design', description: 'Designers', memberIds: ['u1', 'u2'] };
    expect(isOrgGroupFormDirty(initial, initial)).toBe(false);
    expect(isOrgGroupFormDirty({ ...initial, memberIds: ['u2', 'u1'] }, initial)).toBe(false);
    expect(isOrgGroupFormDirty({ ...initial, memberIds: ['u1'] }, initial)).toBe(true);
    expect(isOrgGroupFormDirty({ ...initial, name: 'Designers' }, initial)).toBe(true);
  });
});

describe('orgGroupFormExit', () => {
  const LIST = 'groups';
  const FORM = 'group-form';

  it('returns to the list beneath the form, naming its route key', () => {
    expect(
      orgGroupFormExit({
        routes: [
          { key: 'groups-1', name: LIST },
          { key: 'form-1', name: FORM },
        ],
        currentIndex: 1,
        listRouteName: LIST,
      })
    ).toEqual({ kind: 'list', listRouteKey: 'groups-1' });
  });

  it('returns to the nearest list with screens of other names between them', () => {
    expect(
      orgGroupFormExit({
        routes: [
          { key: 'groups-outer', name: LIST },
          { key: 'modes-1', name: 'modes' },
          { key: 'groups-2', name: LIST },
          { key: 'form-1', name: FORM },
        ],
        currentIndex: 3,
        listRouteName: LIST,
      })
    ).toEqual({ kind: 'list', listRouteKey: 'groups-2' });
  });

  it('ignores a list registered above the form', () => {
    expect(
      orgGroupFormExit({
        routes: [
          { key: 'form-1', name: FORM },
          { key: 'groups-1', name: LIST },
        ],
        currentIndex: 0,
        listRouteName: LIST,
      })
    ).toEqual({ kind: 'push-list' });
  });

  it('goes back when no list is beneath and the stack has one', () => {
    expect(
      orgGroupFormExit({
        routes: [
          { key: 'members-1', name: 'members' },
          { key: 'form-1', name: FORM },
        ],
        currentIndex: 1,
        listRouteName: LIST,
      })
    ).toEqual({ kind: 'back' });
  });

  it('replaces itself with the list when the form is the only route of its stack', () => {
    expect(
      orgGroupFormExit({
        routes: [{ key: 'form-1', name: FORM }],
        currentIndex: 0,
        listRouteName: LIST,
      })
    ).toEqual({ kind: 'push-list' });
  });
});

describe('isOrgGroupFormDraft', () => {
  it('accepts the whole form', () => {
    expect(
      isOrgGroupFormDraft({
        name: 'Workshop',
        description: 'The workshop group',
        memberIds: ['user-1'],
        memberQuery: 'am',
      })
    ).toBe(true);
  });

  it('refuses another build’s value instead of coercing it', () => {
    expect(
      isOrgGroupFormDraft({ name: 'Workshop', description: '', memberIds: [1], memberQuery: '' })
    ).toBe(false);
    // A draft that lost its search has another build's shape, not this one's.
    expect(isOrgGroupFormDraft({ name: 'Workshop', description: '', memberIds: [] })).toBe(false);
    expect(
      isOrgGroupFormDraft({
        name: 'Workshop',
        description: '',
        memberIds: [],
        memberQuery: '',
        extra: true,
      })
    ).toBe(false);
    expect(isOrgGroupFormDraft(null)).toBe(false);
  });
});
