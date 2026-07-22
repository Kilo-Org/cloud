import {
  heartbeatIdempotencyKey,
  heartbeatAckSchema,
  recordAckSchema,
  recordStartResultSchema,
  startIdempotencyKey,
  stopIdempotencyKey,
  type ContainerUsageRpcMethods,
  type HeartbeatAck,
  type RecordAck,
  type RecordHeartbeatInput,
  type RecordStartInput,
  type RecordStartFailureCode,
  type RecordStopInput,
  type UsageContext,
} from './contracts';

export type ContainerUsageClientOptions = {
  service: string;
  retry?: {
    attempts?: number;
    initialDelayMs?: number;
    maximumDelayMs?: number;
  };
};

export type ClientUsageContext = Omit<UsageContext, 'service'>;
export type ClientRecordStartInput = ClientUsageContext & { startEpochMs: number };
export type ClientRecordHeartbeatInput = Omit<
  RecordHeartbeatInput,
  'service' | 'idempotencyKey' | 'context'
> & {
  context: ClientUsageContext;
};
export type ClientRecordStopInput = Omit<
  RecordStopInput,
  'service' | 'idempotencyKey' | 'context'
> & {
  context: ClientUsageContext;
};

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 100;
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 1_000;

export class ContainerUsageAdmissionError extends Error {
  constructor(
    readonly code: RecordStartFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'ContainerUsageAdmissionError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class ContainerUsageClient {
  readonly service: string;
  private readonly retryAttempts: number;
  private readonly initialRetryDelayMs: number;
  private readonly maximumRetryDelayMs: number;

  constructor(
    private readonly binding: ContainerUsageRpcMethods,
    options: ContainerUsageClientOptions
  ) {
    if (options.service.length === 0) {
      throw new Error('Container usage service name must not be empty');
    }
    this.service = options.service;
    this.retryAttempts = options.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.initialRetryDelayMs = options.retry?.initialDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    this.maximumRetryDelayMs = options.retry?.maximumDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS;

    if (this.retryAttempts < 1) {
      throw new Error('Container usage retry attempts must be at least one');
    }
    if (!Number.isSafeInteger(this.retryAttempts)) {
      throw new Error('Container usage retry attempts must be a finite integer');
    }
    if (!Number.isFinite(this.initialRetryDelayMs) || this.initialRetryDelayMs < 0) {
      throw new Error('Container usage initial retry delay must be finite and nonnegative');
    }
    if (!Number.isFinite(this.maximumRetryDelayMs) || this.maximumRetryDelayMs < 0) {
      throw new Error('Container usage maximum retry delay must be finite and nonnegative');
    }
  }

  async recordStart(input: ClientRecordStartInput): Promise<RecordAck> {
    const request = {
      ...input,
      service: this.service,
      idempotencyKey: startIdempotencyKey(this.service, input.instanceId, input.startEpochMs),
    } satisfies RecordStartInput;
    const result = await this.withRetry(async () =>
      recordStartResultSchema.parse(await this.binding.recordStart(request))
    );
    if (!result.success) {
      throw new ContainerUsageAdmissionError(result.error.code, result.error.message);
    }
    return result.ack;
  }

  async recordHeartbeat(input: ClientRecordHeartbeatInput): Promise<HeartbeatAck> {
    const request = {
      ...input,
      service: this.service,
      idempotencyKey: heartbeatIdempotencyKey(
        this.service,
        input.instanceId,
        input.startEpochMs,
        input.seq
      ),
      context: { ...input.context, service: this.service },
    } satisfies RecordHeartbeatInput;
    return await this.withRetry(async () =>
      heartbeatAckSchema.parse(await this.binding.recordHeartbeat(request))
    );
  }

  async recordStop(input: ClientRecordStopInput): Promise<RecordAck> {
    const request = {
      ...input,
      service: this.service,
      idempotencyKey: stopIdempotencyKey(this.service, input.instanceId, input.startEpochMs),
      context: { ...input.context, service: this.service },
    } satisfies RecordStopInput;
    return await this.withRetry(async () =>
      recordAckSchema.parse(await this.binding.recordStop(request))
    );
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let delayMs = this.initialRetryDelayMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === this.retryAttempts) break;
        await delay(delayMs);
        delayMs = Math.min(delayMs * 2, this.maximumRetryDelayMs);
      }
    }
    throw lastError;
  }
}

export function createContainerUsageClient(
  binding: ContainerUsageRpcMethods,
  options: ContainerUsageClientOptions
): ContainerUsageClient {
  return new ContainerUsageClient(binding, options);
}
