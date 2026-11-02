import { describe, expect, it, jest } from '@jest/globals';
import { adminStepUpUiRule } from './step-up-ui';

describe('adminStepUpUiRule', () => {
  it('is false for a non-admin even when the toggle is on', async () => {
    const enrollmentEnabled = jest.fn(async () => true);
    await expect(
      adminStepUpUiRule({ isAdmin: false, mode: 'observe', enrollmentEnabled })
    ).resolves.toBe(false);
    expect(enrollmentEnabled).not.toHaveBeenCalled();
  });

  it('is true in observe without reading the enrollment toggle', async () => {
    const enrollmentEnabled = jest.fn(async () => false);
    await expect(
      adminStepUpUiRule({ isAdmin: true, mode: 'observe', enrollmentEnabled })
    ).resolves.toBe(true);
    expect(enrollmentEnabled).not.toHaveBeenCalled();
  });

  it('is false when off and enrollment is off', async () => {
    await expect(
      adminStepUpUiRule({
        isAdmin: true,
        mode: 'off',
        enrollmentEnabled: async () => false,
      })
    ).resolves.toBe(false);
  });

  it('is true when off but enrollment is enabled for this admin', async () => {
    await expect(
      adminStepUpUiRule({
        isAdmin: true,
        mode: 'off',
        enrollmentEnabled: async () => true,
      })
    ).resolves.toBe(true);
  });
});
