/* eslint-disable max-lines -- the interceptor's contract is one table of pauses over one fake: split it and the
   release rules stop being readable side by side. */
/* eslint-disable vitest/max-expects -- each case asserts the pause's answer, its state and the release together. */
import { describe, expect, it } from 'vitest';
import {
  DOWNLOAD_FAIL_REASON,
  DOWNLOAD_RESPONSE_PATTERNS,
  downloadResponseName,
  downloadResponsePause,
  INTERCEPT_POLL_MS,
  INTERCEPT_WAIT_MS,
  interceptWait,
  isDownloadResponse,
} from './browser-download-intercept';
import type { InterceptWaitReading, InterceptWaitState } from './browser-download-intercept';

const attachmentPause = (requestId: string) => ({
  documentURL: 'https://app.example/reports/q4.pdf',
  request: { url: 'https://app.example/reports/q4.pdf' },
  requestId,
  responseHeaders: [
    { name: 'Content-Disposition', value: 'attachment; filename="q4.pdf"' },
    { name: 'Content-Type', value: 'text/plain' },
  ],
});

describe('the response pause', () => {
  it('reads the response that would become a file, and names it by its Content-Disposition', () => {
    const pause = downloadResponsePause(attachmentPause('r1'));

    expect(pause).toBeDefined();
    expect(pause === undefined ? false : isDownloadResponse(pause)).toBe(true);
    expect(pause === undefined ? '' : downloadResponseName(pause)).toBe('q4.pdf');
    // The tier arms Document responses only: a catch-all would pause every image and script on the tab.
    expect(DOWNLOAD_RESPONSE_PATTERNS).toStrictEqual([
      { requestStage: 'Response', resourceType: 'Document' },
    ]);
  });

  it('continues a rendered page and fails a file, with the protocol reason that writes nothing', () => {
    const page = downloadResponsePause({
      documentURL: 'https://app.example/dashboard',
      requestId: 'r2',
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
    });

    expect(page === undefined ? true : isDownloadResponse(page)).toBe(false);
    expect(DOWNLOAD_FAIL_REASON).toBe('Aborted');
  });
});

describe('the settle that keeps the pause armed', () => {
  const answered = (...ids: readonly string[]) => new Set(ids);
  const reading = (
    overrides: Partial<InterceptWaitReading> & { readonly now: number }
  ): InterceptWaitReading => ({
    answeredIds: answered(),
    documents: [],
    ...overrides,
  });

  it('releases at once for a call that started no Document, after one confirming poll', () => {
    const start: InterceptWaitState = { kind: 'entered', since: 1_000 };

    // The very first read confirms: the call's own navigation request can be recorded after the tool answered.
    expect(interceptWait(start, reading({ now: 1_000 }))).toStrictEqual({
      state: start,
      step: 'hold',
    });
    expect(interceptWait(start, reading({ now: 1_000 + INTERCEPT_POLL_MS }))).toStrictEqual({
      state: { kind: 'released' },
      step: 'release',
    });
  });

  /**
   * The defect this covers: a link click on an attachment answers its tool as soon as the click is dispatched, and the
   * response the browser would save arrives afterwards. Releasing the pause then answers that response with
   * `continueResponse` — the file lands and the model is told nothing — so the settle holds while the call's own
   * Document still owes its answer.
   */
  it('holds an unanswered Document the call started, and releases once the interceptor answered it', () => {
    const start: InterceptWaitState = { kind: 'entered', since: 1_000 };
    const first = 1_000 + INTERCEPT_POLL_MS;
    const owedReading = reading({ documents: [{ requestId: 'nav-1' }], now: first });

    const held = interceptWait(start, owedReading);

    expect(held).toStrictEqual({
      state: { deadline: first + INTERCEPT_WAIT_MS, kind: 'owed' },
      step: 'hold',
    });

    // Still unanswered, well past the confirming poll: the pause is the only thing that can still fail the file.
    expect(
      interceptWait(held.state, { ...owedReading, now: first + INTERCEPT_POLL_MS * 5 }).step
    ).toBe('hold');

    // The interceptor failed the attachment response: the Document is answered and nothing is left to wait for.
    expect(
      interceptWait(held.state, {
        ...owedReading,
        answeredIds: answered('nav-1'),
        now: first + INTERCEPT_POLL_MS * 6,
      })
    ).toStrictEqual({ state: { kind: 'released' }, step: 'release' });
  });

  it('releases an unanswered Document at the bound rather than holding the page forever', () => {
    const documents = [{ requestId: 'nav-1' }];
    const state: InterceptWaitState = { deadline: 2_000, kind: 'owed' };

    expect(interceptWait(state, reading({ documents, now: 1_999 })).step).toBe('hold');
    expect(interceptWait(state, reading({ documents, now: 2_000 }))).toStrictEqual({
      state: { kind: 'released' },
      step: 'release',
    });
  });

  it('stays released whatever a later read says', () => {
    expect(
      interceptWait(
        { kind: 'released' },
        reading({ documents: [{ requestId: 'nav-1' }], now: 1_001 })
      )
    ).toStrictEqual({ state: { kind: 'released' }, step: 'release' });
  });
});
