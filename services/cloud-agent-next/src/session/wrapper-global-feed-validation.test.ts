import { describe, expect, it } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata';
import type { WrapperRuntimeState } from './wrapper-runtime-state';
import { validateKiloGlobalFeedProducerIdentity } from './wrapper-global-feed-validation';

const producer = {
  kiloSessionId: 'ses_12345678901234567890123456',
  wrapperRunId: 'wr_current',
  wrapperGeneration: 3,
  wrapperConnectionId: 'conn_current',
};

const metadata = {
  auth: { kiloSessionId: producer.kiloSessionId },
} as SessionMetadata;

const runtimeState = {
  wrapperGeneration: producer.wrapperGeneration,
  wrapperConnectionId: producer.wrapperConnectionId,
  wrapperRunId: producer.wrapperRunId,
} as WrapperRuntimeState;

describe('validateKiloGlobalFeedProducerIdentity', () => {
  it('accepts the current wrapper feed for the metadata root Kilo session', () => {
    expect(
      validateKiloGlobalFeedProducerIdentity({
        metadata,
        runtimeState,
        producer,
      })
    ).toEqual({ success: true });
  });

  it('rejects claimed root Kilo session IDs that do not match metadata', () => {
    expect(
      validateKiloGlobalFeedProducerIdentity({
        metadata,
        runtimeState,
        producer: { ...producer, kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
      })
    ).toEqual({ success: false, status: 403, message: 'Root Kilo session mismatch' });
  });

  it('rejects stale wrapper runs', () => {
    expect(
      validateKiloGlobalFeedProducerIdentity({
        metadata,
        runtimeState,
        producer: { ...producer, wrapperRunId: 'wr_old' },
      })
    ).toEqual({ success: false, status: 409, message: 'Stale wrapper run' });
  });

  it('rejects stale wrapper generations or connection IDs', () => {
    expect(
      validateKiloGlobalFeedProducerIdentity({
        metadata,
        runtimeState,
        producer: { ...producer, wrapperConnectionId: 'conn_old' },
      })
    ).toEqual({ success: false, status: 409, message: 'Stale wrapper connection' });
  });
});
