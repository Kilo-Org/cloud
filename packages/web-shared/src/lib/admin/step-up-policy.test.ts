import { describe, expect, test } from '@jest/globals';
import { PRIVILEGED_ACTION_CLASSES } from '@kilocode/web-shared/lib/admin/privileged-access';
import { isOperationStepUpClass } from '@kilocode/web-shared/lib/admin/step-up-policy';

describe('step-up policy', () => {
  test('the classes that change another account or the platform need an operation proof', () => {
    expect(PRIVILEGED_ACTION_CLASSES.filter(isOperationStepUpClass)).toEqual([
      'sensitive_write',
      'support_write',
      'worker_admin',
    ]);
  });
});
