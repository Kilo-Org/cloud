/**
 * Shared display types and lifecycle helpers for the typed `userExports` tRPC
 * router. The explicit status union keeps UI behavior easy to review.
 */

/**
 * Digits in an emailed download code.
 *
 * The per-code attempt budget resets whenever a new code is issued, so it caps
 * the guess *rate*, not the total. The search space is therefore what bounds a
 * held session's odds over time, which is why this is wider than the 6 digits a
 * sign-in code uses: those are spent in one sitting, this one is not.
 */
export const DOWNLOAD_CODE_LENGTH = 8;

export type DownloadCodeChallenge = {
  exportId: string;
  challengeId: string;
  expiresAt: number;
};

export function canReuseDownloadCodeChallenge(
  challenge: DownloadCodeChallenge | null,
  exportId: string,
  now = Date.now()
): challenge is DownloadCodeChallenge {
  return challenge?.exportId === exportId && challenge.expiresAt > now;
}

export const USER_EXPORT_STATUSES = [
  'queued',
  'processing',
  'finalizing',
  'ready',
  'failed',
  'expired',
] as const;

export type UserExportStatus = (typeof USER_EXPORT_STATUSES)[number];

/** Whose data an export holds, which is not necessarily who requested it. */
export type UserExportSubjectType = 'user' | 'organization';

/** User-safe fields returned by `userExports.list`. */
export type UserExport = {
  id: string;
  subjectType: UserExportSubjectType;
  /** Both null for a personal export. */
  organizationId: string | null;
  organizationName: string | null;
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

/** An organization the signed in person may export, from `exportableOrganizations`. */
export type ExportableOrganization = { id: string; name: string };

/**
 * The export in flight for one subject, or undefined.
 *
 * Each button is governed by its own subject: a personal export generating must not
 * disable an organization's button, and vice versa, because the server tracks the two
 * separately and would accept the request.
 */
export function findActiveExport(
  records: readonly UserExport[] | null | undefined,
  organizationId: string | null
): UserExport | undefined {
  return records?.find(
    record =>
      isActiveUserExportStatus(record.status) &&
      (organizationId === null
        ? record.subjectType === 'user'
        : record.organizationId === organizationId)
  );
}

/** The most recent downloadable export for one subject, on the same basis. */
export function findReadyExport(
  records: readonly UserExport[] | null | undefined,
  organizationId: string | null,
  now: Date = new Date()
): UserExport | undefined {
  return records?.find(
    record =>
      getDisplayStatus(record, now) === 'ready' &&
      (organizationId === null
        ? record.subjectType === 'user'
        : record.organizationId === organizationId)
  );
}

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
    description: 'The export could not be completed. Request another export when available.',
  },
  expired: {
    label: 'Expired',
    description: 'This export has expired. Request another export when available.',
  },
};
