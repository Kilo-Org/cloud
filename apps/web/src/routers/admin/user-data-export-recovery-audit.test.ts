import {
  recordDataExportRecovery,
  setDataExportRecoveryAuditSinkForTest,
  type DataExportRecoveryAuditEvent,
} from './user-data-export-recovery-audit';

afterEach(() => setDataExportRecoveryAuditSinkForTest(null));

const event: Omit<DataExportRecoveryAuditEvent, 'event'> = {
  action: 'cancel_and_purge',
  actorAdminId: 'admin-id',
  exportOwnerId: 'owner-id',
  exportId: 'export-id',
  expectedGeneration: 3,
  resultingGeneration: null,
  replacementExportId: null,
  cleanupQueued: true,
};

describe('recordDataExportRecovery', () => {
  it('emits an attributable structured recovery event', () => {
    const sink = jest.fn();
    setDataExportRecoveryAuditSinkForTest(sink);

    recordDataExportRecovery(event);

    expect(sink).toHaveBeenCalledWith({ event: 'admin_data_export_recovery', ...event });
  });

  it('never fails a completed recovery action when the audit sink throws', () => {
    setDataExportRecoveryAuditSinkForTest(() => {
      throw new Error('audit transport unavailable');
    });

    expect(() => recordDataExportRecovery(event)).not.toThrow();
  });
});
