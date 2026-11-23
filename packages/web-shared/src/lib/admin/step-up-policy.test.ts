import { describe, expect, test } from '@jest/globals';
import { PRIVILEGED_ACTION_CLASSES } from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  isCredentialExemptibleClass,
  isOperationStepUpClass,
} from '@kilocode/web-shared/lib/admin/step-up-policy';

describe('step-up credential exemption policy', () => {
  test('only the read-grade classes can be exempted', () => {
    expect(PRIVILEGED_ACTION_CLASSES.filter(isCredentialExemptibleClass)).toEqual([
      'platform_read',
      'support_read',
    ]);
  });

  test('an operation-bound class is never exemptible', () => {
    for (const actionClass of PRIVILEGED_ACTION_CLASSES) {
      if (isOperationStepUpClass(actionClass)) {
        expect(isCredentialExemptibleClass(actionClass)).toBe(false);
      }
    }
  });
});
