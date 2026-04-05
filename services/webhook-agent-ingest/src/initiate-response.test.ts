import { describe, it, expect } from 'vitest';
import { classifyInitiateResponse } from './initiate-response';

function makeResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('classifyInitiateResponse', () => {
  it('returns ack for 200 OK', async () => {
    const result = await classifyInitiateResponse(makeResponse(200, '{}'));
    expect(result).toEqual({ action: 'ack' });
  });

  it('returns ack for 409 (execution already in progress)', async () => {
    const result = await classifyInitiateResponse(
      makeResponse(409, 'Execution already in progress')
    );
    expect(result).toEqual({ action: 'ack' });
  });

  it('returns ack for 409 with empty body', async () => {
    const result = await classifyInitiateResponse(makeResponse(409));
    expect(result).toEqual({ action: 'ack' });
  });

  it('returns ack for 400 "Session has already been initiated"', async () => {
    const result = await classifyInitiateResponse(
      makeResponse(400, 'Session has already been initiated')
    );
    expect(result).toEqual({ action: 'ack' });
  });

  it('returns retry for 503 (retryable sandbox failure)', async () => {
    const result = await classifyInitiateResponse(makeResponse(503, 'sandbox startup failed'));
    expect(result).toEqual({
      action: 'retry',
      errorMessage: 'initiateFromKilocodeSessionV2 returned retryable 503: sandbox startup failed',
    });
  });

  it('returns retry for 503 with empty body', async () => {
    const result = await classifyInitiateResponse(makeResponse(503));
    expect(result).toEqual({
      action: 'retry',
      errorMessage: 'initiateFromKilocodeSessionV2 returned retryable 503: ',
    });
  });

  it('returns throw for generic 500', async () => {
    const result = await classifyInitiateResponse(makeResponse(500, 'Internal server error'));
    expect(result).toEqual({
      action: 'throw',
      errorMessage: 'initiateFromKilocodeSessionV2 failed: 500 - Internal server error',
    });
  });

  it('returns throw for 502', async () => {
    const result = await classifyInitiateResponse(makeResponse(502, 'Bad gateway'));
    expect(result).toEqual({
      action: 'throw',
      errorMessage: 'initiateFromKilocodeSessionV2 failed: 502 - Bad gateway',
    });
  });

  it('returns fail for 402 (insufficient balance)', async () => {
    const result = await classifyInitiateResponse(makeResponse(402, 'Insufficient credits'));
    expect(result).toEqual({
      action: 'fail',
      errorMessage: 'Insufficient credits',
    });
  });

  it('returns fail for 402 with empty body, using default message', async () => {
    const result = await classifyInitiateResponse(makeResponse(402));
    expect(result).toEqual({
      action: 'fail',
      errorMessage: 'Insufficient balance',
    });
  });

  it('returns fail for other 4xx errors', async () => {
    const result = await classifyInitiateResponse(makeResponse(422, 'Validation failed'));
    expect(result).toEqual({
      action: 'fail',
      errorMessage: 'Validation failed',
    });
  });

  it('returns fail for 400 without "Session has already been initiated"', async () => {
    const result = await classifyInitiateResponse(makeResponse(400, 'Bad request'));
    expect(result).toEqual({
      action: 'fail',
      errorMessage: 'Bad request',
    });
  });

  // 503 is classified distinctly from other 5xx — verify ordering
  it('classifies 503 as retry, not generic throw', async () => {
    const result = await classifyInitiateResponse(makeResponse(503, 'workspace error'));
    expect(result.action).toBe('retry');
  });

  it('classifies 500 as throw, not retry', async () => {
    const result = await classifyInitiateResponse(makeResponse(500, 'crash'));
    expect(result.action).toBe('throw');
  });
});
