import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_TASK_TYPES,
  SUBTYPES_BY_TASK_TYPE,
  TaxonomyRouteKeySchema,
  taxonomyRouteKey,
} from './taxonomy';

describe('classifier taxonomy', () => {
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
