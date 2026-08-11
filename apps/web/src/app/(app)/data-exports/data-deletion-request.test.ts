import { DATA_DELETION_COPY, DATA_DELETION_SUPPORT_PATH } from './data-deletion-request';

describe('data deletion request', () => {
  it('points at the support form that creates the deletion request', () => {
    expect(DATA_DELETION_SUPPORT_PATH).toBe('/support');
  });

  it('warns that the export must be downloaded before deletion', () => {
    expect(DATA_DELETION_COPY.dialogDescription).toMatch(/download your data export before/i);
  });

  it('warns that the download stops being available once data is deleted', () => {
    expect(DATA_DELETION_COPY.dialogDescription).toMatch(/no longer be available/i);
  });

  it('names the support form category, which cannot be preselected from the link', () => {
    expect(DATA_DELETION_COPY.dialogInstruction).toContain('Account Deletion');
  });

  it('uses action labels that name the action', () => {
    const bannedLabels = ['OK', 'Submit', 'Yes', 'No', 'Click here'];
    expect(bannedLabels).not.toContain(DATA_DELETION_COPY.confirmLabel);
    expect(bannedLabels).not.toContain(DATA_DELETION_COPY.triggerLabel);
  });
});
