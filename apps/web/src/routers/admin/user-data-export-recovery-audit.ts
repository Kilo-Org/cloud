import 'server-only';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest } from '@/lib/utils.server';

export type DataExportRecoveryAuditEvent = {
  event: 'admin_data_export_recovery';
  action: 'redispatch' | 'cancel_and_purge' | 'cancel_and_retry';
  actorAdminId: string;
  exportOwnerId: string;
  exportId: string;
  expectedGeneration: number;
  resultingGeneration: number | null;
  replacementExportId: string | null;
  cleanupQueued: boolean;
};

type RecoveryAuditSink = (event: DataExportRecoveryAuditEvent) => void;

const defaultSink: RecoveryAuditSink = event => logExceptInTest(JSON.stringify(event));
let currentSink = defaultSink;

export function setDataExportRecoveryAuditSinkForTest(sink: RecoveryAuditSink | null): void {
  currentSink = sink ?? defaultSink;
}

export function recordDataExportRecovery(event: Omit<DataExportRecoveryAuditEvent, 'event'>): void {
  try {
    currentSink({ event: 'admin_data_export_recovery', ...event });
  } catch (error) {
    captureException(error, { tags: { operation: 'admin_data_export_recovery_audit' } });
  }
}
