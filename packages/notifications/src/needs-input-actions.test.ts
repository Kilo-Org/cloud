import { describe, expect, it } from 'vitest';

import {
  NEEDS_INPUT_ACTION_IDS,
  NEEDS_INPUT_KINDS,
  needsInputCategoryDescriptors,
  needsInputCategoryId,
  type NeedsInputKind,
} from './needs-input-actions';

describe('NEEDS_INPUT_ACTION_IDS', () => {
  it('pins the ids the server registers and the app dispatches on', () => {
    expect(NEEDS_INPUT_ACTION_IDS).toEqual({
      approve: 'kilo:approve',
      reply: 'kilo:reply',
      openPr: 'kilo:open-pr',
      openSession: 'kilo:open-session',
    });
  });
});

// The ids must be stable and independent of copy: they are wire values, not
// user-visible strings, so this table is asserted literally.
const expectedCategoryIds: ReadonlyArray<[NeedsInputKind, boolean, string]> = [
  ['question', false, 'kilo-needs-input:question'],
  ['question', true, 'kilo-needs-input:question-pr'],
  ['permission', false, 'kilo-needs-input:permission'],
  ['permission', true, 'kilo-needs-input:permission-pr'],
  ['unknown', false, 'kilo-needs-input:unknown'],
  ['unknown', true, 'kilo-needs-input:unknown-pr'],
];

describe('needsInputCategoryId', () => {
  it('pins every (kind × hasPr) id', () => {
    for (const [kind, hasPr, id] of expectedCategoryIds) {
      expect(needsInputCategoryId({ kind, hasPr })).toBe(id);
    }
  });

  it('covers every kind with and without a PR', () => {
    const covered = new Set(expectedCategoryIds.map(([kind, hasPr]) => `${kind}:${hasPr}`));
    for (const kind of NEEDS_INPUT_KINDS) {
      expect(covered.has(`${kind}:false`)).toBe(true);
      expect(covered.has(`${kind}:true`)).toBe(true);
    }
    expect(expectedCategoryIds).toHaveLength(NEEDS_INPUT_KINDS.length * 2);
  });
});

describe('needsInputCategoryDescriptors', () => {
  const expectedDescriptors = [
    { id: 'kilo-needs-input:question', actionIds: ['kilo:reply', 'kilo:open-session'] },
    {
      id: 'kilo-needs-input:question-pr',
      actionIds: ['kilo:reply', 'kilo:open-session', 'kilo:open-pr'],
    },
    { id: 'kilo-needs-input:permission', actionIds: ['kilo:approve', 'kilo:open-session'] },
    {
      id: 'kilo-needs-input:permission-pr',
      actionIds: ['kilo:approve', 'kilo:open-session', 'kilo:open-pr'],
    },
    {
      id: 'kilo-needs-input:unknown',
      actionIds: ['kilo:approve', 'kilo:reply', 'kilo:open-session'],
    },
    {
      id: 'kilo-needs-input:unknown-pr',
      actionIds: ['kilo:approve', 'kilo:reply', 'kilo:open-session', 'kilo:open-pr'],
    },
  ];

  it('registers one descriptor per (kind × hasPr) with ordered action ids', () => {
    expect(needsInputCategoryDescriptors()).toEqual(expectedDescriptors);
  });

  it('returns ids that satisfy needsInputCategoryId for their kind and PR state', () => {
    for (const [index, descriptor] of needsInputCategoryDescriptors().entries()) {
      const [kind, hasPr] = expectedCategoryIds[index];
      expect(descriptor.id).toBe(needsInputCategoryId({ kind, hasPr }));
    }
  });

  it('never registers a button that cannot act', () => {
    const actionIdsById = new Map(
      needsInputCategoryDescriptors().map(d => [d.id, d.actionIds] as const)
    );

    // A question cannot be approved; a permission has no free-text answer.
    expect(actionIdsById.get('kilo-needs-input:question')).not.toContain(
      NEEDS_INPUT_ACTION_IDS.approve
    );
    expect(actionIdsById.get('kilo-needs-input:question-pr')).not.toContain(
      NEEDS_INPUT_ACTION_IDS.approve
    );
    expect(actionIdsById.get('kilo-needs-input:permission')).not.toContain(
      NEEDS_INPUT_ACTION_IDS.reply
    );
    expect(actionIdsById.get('kilo-needs-input:permission-pr')).not.toContain(
      NEEDS_INPUT_ACTION_IDS.reply
    );

    // Open PR only where a pull request exists; Open session always.
    for (const [id, actionIds] of actionIdsById) {
      if (id.endsWith('-pr')) {
        expect(actionIds).toContain(NEEDS_INPUT_ACTION_IDS.openPr);
      } else {
        expect(actionIds).not.toContain(NEEDS_INPUT_ACTION_IDS.openPr);
      }
      expect(actionIds).toContain(NEEDS_INPUT_ACTION_IDS.openSession);
    }
  });

  it('holds only machine ids, never copy', () => {
    const descriptors = needsInputCategoryDescriptors();
    expect(new Set(descriptors.map(d => d.id)).size).toBe(descriptors.length);

    for (const { id, actionIds } of descriptors) {
      expect(id).toMatch(/^kilo-needs-input:(question|permission|unknown)(-pr)?$/);
      for (const actionId of actionIds) {
        expect(actionId).toMatch(/^kilo:[a-z-]+$/);
      }
    }
  });
});
