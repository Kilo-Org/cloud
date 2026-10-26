import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_SUBTASK_TYPES,
  CLASSIFIER_TASK_TYPES,
  SUBTYPES_BY_TASK_TYPE,
  TAXONOMY_ROUTE_KEYS,
  TaxonomyRouteKeySchema,
  taxonomyRouteKey,
} from './taxonomy';

const MAPPING_PAIRS = Object.entries(SUBTYPES_BY_TASK_TYPE).flatMap(([taskType, subtypes]) =>
  subtypes.map(subtype => `${taskType}/${subtype}`)
);

describe('classifier taxonomy', () => {
  it('derives every route key from the task-to-subtype mapping exactly once', () => {
    expect([...TAXONOMY_ROUTE_KEYS]).toEqual(MAPPING_PAIRS);
    expect(new Set(TAXONOMY_ROUTE_KEYS).size).toBe(MAPPING_PAIRS.length);
  });

  it('derives the flat task and subtype lists from the same mapping', () => {
    expect([...CLASSIFIER_TASK_TYPES]).toEqual(Object.keys(SUBTYPES_BY_TASK_TYPE));
    expect([...CLASSIFIER_SUBTASK_TYPES]).toEqual(Object.values(SUBTYPES_BY_TASK_TYPE).flat());
  });

  it('builds a valid route key for every pair in the mapping', () => {
    for (const taskType of CLASSIFIER_TASK_TYPES) {
      for (const subtaskType of SUBTYPES_BY_TASK_TYPE[taskType]) {
        expect(
          TaxonomyRouteKeySchema.safeParse(taxonomyRouteKey({ taskType, subtaskType })).success
        ).toBe(true);
      }
    }
  });

  it('rejects a subtask from another task type', () => {
    expect(TaxonomyRouteKeySchema.safeParse('debugging/code_generation').success).toBe(false);
  });
});

// Never called: this only has to typecheck. A subtask may only pair with the
// task type that owns it in SUBTYPES_BY_TASK_TYPE.
function compileOnlyRejectsCrossPairs() {
  // @ts-expect-error code_generation belongs to implementation, not debugging
  taxonomyRouteKey({ taskType: 'debugging', subtaskType: 'code_generation' });
}
void compileOnlyRejectsCrossPairs;
