import {
  getCodingPlanProviderDisplayName,
  getReplacementCompleteToast,
  getReplacementDialogCopy,
  getRevocationCompleteToast,
  getRevocationDialogCopy,
} from '@/app/admin/coding-plans/coding-plan-operations';

const CATALOG = [
  { providerId: 'minimax', providerName: 'MiniMax' },
  { providerId: 'byteplus-coding', providerName: 'BytePlus' },
];

describe('getCodingPlanProviderDisplayName', () => {
  it('resolves provider names from the catalog', () => {
    expect(getCodingPlanProviderDisplayName(CATALOG, 'byteplus-coding')).toBe('BytePlus');
    expect(getCodingPlanProviderDisplayName(CATALOG, 'minimax')).toBe('MiniMax');
  });

  it('falls back to the provider ID for historical or unknown rows', () => {
    expect(getCodingPlanProviderDisplayName(CATALOG, 'legacy-provider')).toBe('legacy-provider');
    expect(getCodingPlanProviderDisplayName([], 'byteplus-coding')).toBe('byteplus-coding');
  });
});

describe('provider-aware revocation copy', () => {
  it('names the selected BytePlus work item without mentioning MiniMax', () => {
    const toast = getRevocationCompleteToast('BytePlus');
    const dialog = getRevocationDialogCopy('BytePlus');

    for (const copy of [toast, dialog.title, dialog.description]) {
      expect(copy).toContain('BytePlus');
      expect(copy).not.toContain('MiniMax');
    }
  });

  it('keeps MiniMax copy for MiniMax work items', () => {
    expect(getRevocationCompleteToast('MiniMax')).toBe('MiniMax credential removed from stock.');
    expect(getRevocationDialogCopy('MiniMax').title).toBe('Revoke MiniMax credential?');
  });

  it('stays provider-neutral when the provider is unknown', () => {
    expect(getRevocationCompleteToast(null)).toBe('Credential removed from stock.');
  });
});

describe('provider-aware replacement copy', () => {
  it('names the selected BytePlus work item without mentioning MiniMax', () => {
    const toast = getReplacementCompleteToast('BytePlus');
    const dialog = getReplacementDialogCopy('BytePlus');

    for (const copy of [toast, dialog.title, dialog.description, dialog.placeholder]) {
      expect(copy).toContain('BytePlus');
      expect(copy).not.toContain('MiniMax');
    }
  });

  it('keeps MiniMax copy for MiniMax work items', () => {
    expect(getReplacementCompleteToast('MiniMax')).toBe(
      'MiniMax credential replaced and returned to stock.'
    );
    expect(getReplacementDialogCopy('MiniMax').title).toBe('Replace MiniMax API key');
    expect(getReplacementDialogCopy('MiniMax').placeholder).toBe('Paste new MiniMax API key');
  });

  it('stays provider-neutral when the provider is unknown', () => {
    expect(getReplacementCompleteToast(null)).toBe('Credential replaced and returned to stock.');
  });
});
