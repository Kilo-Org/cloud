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
import type {
  DownloadResponsePause,
  InterceptWaitReading,
  InterceptWaitState,
} from './browser-download-intercept';

const attachmentPause = (requestId: string) => ({
  documentURL: 'https://app.example/reports/q4.pdf',
  request: { url: 'https://app.example/reports/q4.pdf' },
  requestId,
  responseHeaders: [
    { name: 'Content-Disposition', value: 'attachment; filename="q4.pdf"' },
    { name: 'Content-Type', value: 'text/plain' },
  ],
});

/** The pause one response head becomes: a head the interceptor rejected is a failure, not an assertion to weaken. */
const pausedOf = (params: Record<string, unknown> | undefined): DownloadResponsePause => {
  const pause = downloadResponsePause(params);

  if (pause === undefined) {
    throw new Error('expected the response head to be paused');
  }

  return pause;
};

describe('the response pause', () => {
  it('reads the response that would become a file, and names it by its Content-Disposition', () => {
    const pause = pausedOf(attachmentPause('r1'));

    expect(isDownloadResponse(pause)).toBe(true);
    expect(downloadResponseName(pause)).toBe('q4.pdf');
    // The tier arms Document responses only: a catch-all would pause every image and script on the tab.
    expect(DOWNLOAD_RESPONSE_PATTERNS).toStrictEqual([
      { requestStage: 'Response', resourceType: 'Document' },
    ]);
  });

  it('continues a rendered page and fails a file, with the protocol reason that writes nothing', () => {
    const page = pausedOf({
      documentURL: 'https://app.example/dashboard',
      requestId: 'r2',
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
    });

    expect(isDownloadResponse(page)).toBe(false);
    expect(DOWNLOAD_FAIL_REASON).toBe('Aborted');
  });

  /**
   * The defect this covers: the check searched the whole header for the word, so `inline; filename="attachment-1.pdf"`
   * matched and an ordinary page load was failed as a download.
   */
  it('reads the disposition type, never a file name that happens to contain it', () => {
    const inline = pausedOf({
      documentURL: 'https://app.example/reports/attachment-1234.pdf',
      requestId: 'r3',
      responseHeaders: [
        { name: 'Content-Disposition', value: 'inline; filename="attachment-1234.pdf"' },
        { name: 'Content-Type', value: 'application/pdf' },
      ],
    });

    expect(isDownloadResponse(inline)).toBe(false);

    // The type alone decides; its case does not.
    const attachment = pausedOf({
      documentURL: 'https://app.example/reports/q4.pdf',
      requestId: 'r4',
      responseHeaders: [{ name: 'Content-Disposition', value: 'ATTACHMENT; filename="q4.pdf"' }],
    });

    expect(isDownloadResponse(attachment)).toBe(true);
  });

  /**
   * The defect this covers: a missing `Content-Type` was read as a file, so a server that sends none had every
   * navigation failed — and an HTML body Chrome would have rendered was reported as a stopped download.
   */
  it('continues a Document without a Content-Type, because Chrome sniffs and renders it', () => {
    const sniffed = pausedOf({
      documentURL: 'https://app.example/no-header',
      requestId: 'r5',
      responseHeaders: [],
    });

    expect(sniffed.mediaType).toBeUndefined();
    expect(isDownloadResponse(sniffed)).toBe(false);

    // A media type no browser renders is still the file it always was, with or without a matching disposition.
    const binary = pausedOf({
      documentURL: 'https://app.example/report.bin',
      requestId: 'r6',
      responseHeaders: [{ name: 'Content-Type', value: 'application/octet-stream' }],
    });

    expect(isDownloadResponse(binary)).toBe(true);
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
    const start: InterceptWaitState = { kind: 'entered', since: 1000 };

    // The very first read confirms: the call's own navigation request can be recorded after the tool answered.
    expect(interceptWait(start, reading({ now: 1000 }))).toStrictEqual({
      state: start,
      step: 'hold',
    });
    expect(interceptWait(start, reading({ now: 1000 + INTERCEPT_POLL_MS }))).toStrictEqual({
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
    const start: InterceptWaitState = { kind: 'entered', since: 1000 };
    const first = 1000 + INTERCEPT_POLL_MS;
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
    const state: InterceptWaitState = { deadline: 2000, kind: 'owed' };

    expect(interceptWait(state, reading({ documents, now: 1999 })).step).toBe('hold');
    expect(interceptWait(state, reading({ documents, now: 2000 }))).toStrictEqual({
      state: { kind: 'released' },
      step: 'release',
    });
  });

  it('stays released whatever a later read says', () => {
    expect(
      interceptWait(
        { kind: 'released' },
        reading({ documents: [{ requestId: 'nav-1' }], now: 1001 })
      )
    ).toStrictEqual({ state: { kind: 'released' }, step: 'release' });
  });
});
