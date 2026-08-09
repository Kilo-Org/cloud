/**
 * Shared display types and lifecycle helpers for the typed `userExports` tRPC
 * router. The explicit status union keeps UI behavior easy to review.
 */

export const USER_EXPORT_STATUSES = [
  'queued',
  'processing',
  'finalizing',
  'ready',
  'failed',
  'expired',
] as const;

export type UserExportStatus = (typeof USER_EXPORT_STATUSES)[number];

/** User-safe fields returned by `userExports.list`. */
export type UserExport = {
  id: string;
  status: UserExportStatus;
  /** Strict UTC ISO timestamps, normalized by the API. */
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  /** Redacted, user-safe failure detail. */
  failureMessage: string | null;
};

export type UserExportsList = {
  exports: UserExport[];
  nextCursor: string | null;
};

/** Poll only while at least one visible export is still active. */
export const USER_EXPORTS_POLL_INTERVAL_MS = 5000;

/**
 * Statuses the UI renders. `finalizing` is an internal lifecycle step between
 * processing and ready; the UI presents it as "Processing".
 */
export type UserExportDisplayStatus = 'queued' | 'processing' | 'ready' | 'failed' | 'expired';

export function isActiveUserExportStatus(status: UserExportStatus): boolean {
  return status === 'queued' || status === 'processing' || status === 'finalizing';
}

export function hasActiveExports(records: readonly UserExport[] | null | undefined): boolean {
  return Boolean(records?.some(record => isActiveUserExportStatus(record.status)));
}

export function getRefetchInterval(data: UserExportsList | undefined): number | false {
  return hasActiveExports(data?.exports) ? USER_EXPORTS_POLL_INTERVAL_MS : false;
}

/**
 * Derive what the user sees. A ready export past its download deadline is shown
 * as expired even when cleanup has not yet updated the stored status.
 */
export function getDisplayStatus(
  record: Pick<UserExport, 'status' | 'expiresAt'>,
  now: Date = new Date()
): UserExportDisplayStatus {
  if (record.status === 'ready' && record.expiresAt !== null) {
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isNaN(expiresAtMs) && expiresAtMs <= now.getTime()) {
      return 'expired';
    }
  }
  if (record.status === 'finalizing') {
    return 'processing';
  }
  return record.status;
}

export const USER_EXPORT_STATUS_COPY: Record<
  UserExportDisplayStatus,
  { label: string; description: string }
> = {
  queued: {
    label: 'Queued',
    description: 'Your export is waiting to start.',
  },
  processing: {
    label: 'Processing',
    description: "You can leave this page. We'll email you when it's ready.",
  },
  ready: {
    label: 'Ready',
    description: 'Your export is ready to download.',
  },
  failed: {
    label: 'Failed',
    description: 'The export could not be completed. You can request a new export.',
  },
  expired: {
    label: 'Expired',
    description: 'This export has expired. Request another export to download your data.',
  },
};
