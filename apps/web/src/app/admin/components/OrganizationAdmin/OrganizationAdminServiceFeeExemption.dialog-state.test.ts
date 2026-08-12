import { describe, expect, it } from '@jest/globals';
import {
  canSubmitServiceFeeExemption,
  resolveServiceFeeExemptionDialogOpenChange,
  SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH,
  SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH,
  shouldBlockServiceFeeExemptionDialogDismiss,
} from './OrganizationAdminServiceFeeExemption.dialog-state';

describe('resolveServiceFeeExemptionDialogOpenChange', () => {
  it('ignores close requests while the mutation is pending', () => {
    expect(
      resolveServiceFeeExemptionDialogOpenChange({ requestedOpen: false, isMutationPending: true })
    ).toBeNull();
  });

  it('ignores reopen requests while the mutation is pending so state is never reset mid-flight', () => {
    expect(
      resolveServiceFeeExemptionDialogOpenChange({ requestedOpen: true, isMutationPending: true })
    ).toBeNull();
  });

  it('resets the mutation only when the dialog opens while idle', () => {
    expect(
      resolveServiceFeeExemptionDialogOpenChange({ requestedOpen: true, isMutationPending: false })
    ).toEqual({ open: true, resetMutation: true });
  });

  it('closes without resetting the mutation while idle', () => {
    expect(
      resolveServiceFeeExemptionDialogOpenChange({
        requestedOpen: false,
        isMutationPending: false,
      })
    ).toEqual({ open: false, resetMutation: false });
  });
});

describe('shouldBlockServiceFeeExemptionDialogDismiss', () => {
  it('blocks Escape, overlay pointer-down, and outside interaction only while pending', () => {
    expect(shouldBlockServiceFeeExemptionDialogDismiss({ isMutationPending: true })).toBe(true);
    expect(shouldBlockServiceFeeExemptionDialogDismiss({ isMutationPending: false })).toBe(false);
  });
});

describe('canSubmitServiceFeeExemption', () => {
  it('rejects a pending mutation even with a valid reason to prevent duplicates', () => {
    expect(
      canSubmitServiceFeeExemption({
        trimmedReasonLength: SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH,
        isMutationPending: true,
      })
    ).toBe(false);
  });

  it('enforces the trimmed reason length bounds while idle', () => {
    const idle = { isMutationPending: false };
    expect(
      canSubmitServiceFeeExemption({
        trimmedReasonLength: SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH - 1,
        ...idle,
      })
    ).toBe(false);
    expect(
      canSubmitServiceFeeExemption({
        trimmedReasonLength: SERVICE_FEE_EXEMPTION_REASON_MIN_LENGTH,
        ...idle,
      })
    ).toBe(true);
    expect(
      canSubmitServiceFeeExemption({
        trimmedReasonLength: SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH,
        ...idle,
      })
    ).toBe(true);
    expect(
      canSubmitServiceFeeExemption({
        trimmedReasonLength: SERVICE_FEE_EXEMPTION_REASON_MAX_LENGTH + 1,
        ...idle,
      })
    ).toBe(false);
  });
});
