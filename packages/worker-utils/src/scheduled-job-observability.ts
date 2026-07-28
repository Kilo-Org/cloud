export const SCHEDULED_JOB_COMPLETED_EVENT = 'scheduled_job.completed' as const;
export const SCHEDULED_JOB_EVENT_VERSION = 1 as const;

export type ScheduledJobMetadataValue = boolean | number | string;

export type ScheduledJobMetadata = Record<string, ScheduledJobMetadataValue | undefined>;

export type ScheduledJobRunContext = {
  runId: string;
  startedAt: number;
};

export type CreateScheduledJobRunContextOptions = {
  runId?: string;
  startedAt?: number;
};

export type CreateScheduledJobRunOptions = CreateScheduledJobRunContextOptions & {
  environment?: string;
  jobName: string;
};

export type ScheduledJobRun = ScheduledJobRunContext & {
  environment?: string;
  jobName: string;
};

type ScheduledJobEventFields = {
  event_name: typeof SCHEDULED_JOB_COMPLETED_EVENT;
  event_version: typeof SCHEDULED_JOB_EVENT_VERSION;
  job_name: string;
  run_id: string;
  duration_ms: number;
  environment?: string;
};

export type ScheduledJobSuccessEvent = ScheduledJobEventFields &
  ScheduledJobMetadata & {
    outcome: 'succeeded';
  };

export type ScheduledJobFailureEvent = ScheduledJobEventFields &
  ScheduledJobMetadata & {
    outcome: 'failed';
    exception_name: string;
  };

export type BuildScheduledJobEventOptions = {
  context: ScheduledJobRunContext;
  jobName: string;
  environment?: string;
  metadata?: ScheduledJobMetadata;
  now?: number;
};

export type BuildScheduledJobFailureEventOptions = BuildScheduledJobEventOptions & {
  error: unknown;
};

export type ScheduledJobLogger = {
  error(message: string): void;
  info(message: string): void;
};

export function createScheduledJobRunContext(
  options: CreateScheduledJobRunContextOptions = {}
): ScheduledJobRunContext {
  return {
    runId: options.runId ?? crypto.randomUUID(),
    startedAt: options.startedAt ?? Date.now(),
  };
}

export function createScheduledJobRun(options: CreateScheduledJobRunOptions): ScheduledJobRun {
  return {
    ...createScheduledJobRunContext(options),
    jobName: options.jobName,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

export function buildScheduledJobSuccessEvent(
  run: ScheduledJobRun,
  metadata?: ScheduledJobMetadata
): ScheduledJobSuccessEvent;
export function buildScheduledJobSuccessEvent(
  options: BuildScheduledJobEventOptions
): ScheduledJobSuccessEvent;
export function buildScheduledJobSuccessEvent(
  options: BuildScheduledJobEventOptions | ScheduledJobRun,
  metadata?: ScheduledJobMetadata
): ScheduledJobSuccessEvent {
  const normalizedOptions = normalizeSuccessEventOptions(options, metadata);
  return {
    ...scalarMetadata(normalizedOptions.metadata),
    ...eventFields(normalizedOptions),
    outcome: 'succeeded',
  };
}

export function buildScheduledJobFailureEvent(
  run: ScheduledJobRun,
  error: unknown
): ScheduledJobFailureEvent;
export function buildScheduledJobFailureEvent(
  options: BuildScheduledJobFailureEventOptions
): ScheduledJobFailureEvent;
export function buildScheduledJobFailureEvent(
  options: BuildScheduledJobFailureEventOptions | ScheduledJobRun,
  error?: unknown
): ScheduledJobFailureEvent {
  const normalizedOptions = normalizeFailureEventOptions(options, error);
  return {
    ...scalarMetadata(normalizedOptions.metadata),
    ...eventFields(normalizedOptions),
    outcome: 'failed',
    exception_name: sanitizedExceptionName(normalizedOptions.error),
  };
}

export function emitScheduledJobEvent(
  event: ScheduledJobSuccessEvent | ScheduledJobFailureEvent,
  logger: ScheduledJobLogger = console
): void {
  try {
    const serializedEvent = JSON.stringify(event);
    if (event.outcome === 'succeeded') {
      logger.info(serializedEvent);
    } else {
      logger.error(serializedEvent);
    }
  } catch {
    // Scheduled job logging must not affect the job result.
  }
}

export function sanitizedExceptionName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError';
  }

  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : 'Error';
}

function eventFields(options: BuildScheduledJobEventOptions): ScheduledJobEventFields {
  return {
    event_name: SCHEDULED_JOB_COMPLETED_EVENT,
    event_version: SCHEDULED_JOB_EVENT_VERSION,
    job_name: options.jobName,
    run_id: options.context.runId,
    duration_ms: Math.max(0, (options.now ?? Date.now()) - options.context.startedAt),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  };
}

function normalizeSuccessEventOptions(
  options: BuildScheduledJobEventOptions | ScheduledJobRun,
  metadata: ScheduledJobMetadata | undefined
): BuildScheduledJobEventOptions {
  if ('context' in options) {
    return options;
  }

  return {
    context: options,
    jobName: options.jobName,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function normalizeFailureEventOptions(
  options: BuildScheduledJobFailureEventOptions | ScheduledJobRun,
  error: unknown
): BuildScheduledJobFailureEventOptions {
  if ('context' in options) {
    return options;
  }

  return {
    context: options,
    jobName: options.jobName,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    error,
  };
}

function scalarMetadata(metadata: ScheduledJobMetadata | undefined): ScheduledJobMetadata {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([, value]) =>
        value !== undefined &&
        (typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)))
    )
  );
}
