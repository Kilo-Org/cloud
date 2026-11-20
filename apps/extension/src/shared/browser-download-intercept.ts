/**
 * The response that would become a download, read where a tab can still stop it.
 *
 * A tab cannot command the download domain through `chrome.debugger`, but it
 * can pause the response that Chrome would turn into a file and fail it before
 * any byte is written. The interceptor is scoped to `Document` responses: every
 * stoppable download measured on real Chrome is a document load — a navigate, a
 * link click, or a hidden iframe — and a catch-all pattern would pause every
 * image, script and font on the tab for a user who declined the optional
 * `downloads` permission.
 *
 * What the pause can tell this predicate is the response head: its headers and
 * its url. Chrome turns a document response into a download when its
 * `Content-Disposition` is an attachment, or when its media type is one Chrome
 * cannot render (an `application/octet-stream` body has no document to show).
 * `application/pdf` is rendered, so it is a page, not a file.
 */
import { z } from 'zod';

/** The one Fetch pattern the interceptor arms: Response-stage Document responses, and nothing else. */
export const DOWNLOAD_RESPONSE_PATTERNS = [
  { requestStage: 'Response', resourceType: 'Document' },
] as const;

/** The protocol reason a stopped response reports: the page load is aborted, and no file exists. */
export const DOWNLOAD_FAIL_REASON = 'Aborted';

/**
 * How long a call keeps its Document pauses armed after the tool answered. A link click's attachment response arrives
 * a few milliseconds after the click returns — measured at 9 ms on real Chrome — so a guard that disarmed with the
 * call would continue the response nobody had answered yet and the file would land.
 */
export const INTERCEPT_WAIT_MS = 1500;

/** How long one settle poll waits before reading the tab again. */
export const INTERCEPT_POLL_MS = 10;

/**
 * How a call's own Document read, for the settle that decides whether its pause stays armed: the Documents the tab
 * started during the call, and which of them the interceptor has already answered.
 */
export interface InterceptWaitReading {
  /** The request ids the interceptor has already answered. */
  readonly answeredIds: ReadonlySet<string>;
  /** The Documents this call started: the only responses the interceptor could still fail for it. */
  readonly documents: readonly { readonly requestId: string }[];
  readonly now: number;
}

/** What the interceptor's settle is waiting for, as one state rather than a pair of flags. */
export type InterceptWaitState =
  /** The settle has just begun: the step's own Document request can be recorded after the tool already answered. */
  | { readonly kind: 'entered'; readonly since: number }
  /**
   * A Document this call started has no answer yet: the pause stays armed until the interceptor answers it or
   * `deadline` passes. The response that becomes a file is one of these, and its pause arrives after the tool returned.
   */
  | { readonly deadline: number; readonly kind: 'owed' }
  /** Every one of the call's Documents is answered, or the bound is spent: the pauses are released. */
  | { readonly kind: 'released' };

/**
 * One step of the settle: whether the pause stays armed, and the state it waits in.
 *
 * The sign is a Document the call started that the interceptor has not answered yet. A plain click's `element.click()`
 * starts none — nothing on the fixture page is an attachment — so such a call releases after one confirming poll. A
 * link click on an attachment starts one, and its pause arrives a few milliseconds later; releasing there would answer
 * it with `continueResponse` and let the file land.
 */
export const interceptWait = (
  state: InterceptWaitState,
  reading: InterceptWaitReading
): { readonly state: InterceptWaitState; readonly step: 'hold' | 'release' } => {
  if (state.kind === 'released') {
    return { state, step: 'release' };
  }

  if (reading.documents.some(document => !reading.answeredIds.has(document.requestId))) {
    // The bound runs from the settle's own entry, never from this poll: a call that keeps seeing its Document
    // Unanswered must still release inside {@link INTERCEPT_WAIT_MS}, or the page hangs behind a pause nobody answers.
    const deadline =
      state.kind === 'owed' ? state.deadline : reading.now + INTERCEPT_WAIT_MS;

    return reading.now < deadline
      ? { state: { deadline, kind: 'owed' }, step: 'hold' }
      : { state: { kind: 'released' }, step: 'release' };
  }

  // The first poll after the tool answered confirms: the call's own navigation request can be recorded last.
  if (state.kind === 'entered' && reading.now < state.since + INTERCEPT_POLL_MS) {
    return { state, step: 'hold' };
  }

  return { state: { kind: 'released' }, step: 'release' };
};

/** Media types Chrome shows as a document instead of saving; anything else with a body is a file. */
const RENDERED_CONTENT_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/pdf',
  'application/xhtml+xml',
  'application/xml',
  'text/css',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/xml',
]);

/** Media type stems Chrome hands to a viewer (an image or a media document), never to the save prompt. */
const RENDERED_TYPE_STEMS: readonly string[] = ['audio/', 'font/', 'image/', 'text/', 'video/'];

/** One response header, as the protocol's `Fetch.requestPaused` reports it. */
const headerSchema = z.object({ name: z.string(), value: z.string() });

/** The pause's own fields: the request to answer, and what names the file it would write. */
const pauseSchema = z.object({
  documentURL: z.string().optional(),
  request: z.object({ url: z.string().optional() }).optional(),
  requestId: z.string(),
  responseHeaders: z.array(headerSchema).optional(),
});

/** One paused response head: what the interceptor's decision reads. */
export interface DownloadResponsePause {
  /** The response's `Content-Disposition`, verbatim. */
  readonly disposition?: string | undefined;
  /** The response's media type, without parameters. */
  readonly mediaType?: string | undefined;
  readonly requestId: string;
  /** The response's url: the name the report falls back to, and what the approval would name. */
  readonly url: string;
}

/** One header's value by its lower-case name; the media type alone keeps `text/plain` out of `text/plain; charset=utf-8`. */
const headerOf = (
  headers: readonly { readonly name: string; readonly value: string }[] | undefined,
  name: string
): string | undefined => headers?.find(header => header.name.toLowerCase() === name)?.value;

/**
 * The pause, read from the protocol's params: `undefined` when the event carries
 * no request to answer, so the caller never pauses a page on nothing.
 */
export const downloadResponsePause = (
  params: Record<string, unknown> | undefined
): DownloadResponsePause | undefined => {
  const parsed = pauseSchema.safeParse(params ?? {});

  if (!parsed.success) {
    return undefined;
  }

  const { documentURL, request, requestId, responseHeaders } = parsed.data;
  const contentType = headerOf(responseHeaders, 'content-type');
  const [mediaType] = (contentType ?? '').split(';');
  const trimmed = mediaType?.trim().toLowerCase() ?? '';

  return {
    disposition: headerOf(responseHeaders, 'content-disposition'),
    mediaType: trimmed === '' ? undefined : trimmed,
    requestId,
    url: documentURL ?? request?.url ?? '',
  };
};

/** Whether Chrome would save this document response as a file rather than show it. */
export const isDownloadResponse = (pause: DownloadResponsePause): boolean => {
  const { disposition, mediaType } = pause;

  if (disposition?.toLowerCase().includes('attachment') === true) {
    return true;
  }

  // No media type at all: Chrome has no renderer to pick, so the body is a file.
  if (mediaType === undefined) {
    return true;
  }

  return (
    !RENDERED_CONTENT_TYPES.has(mediaType) &&
    !RENDERED_TYPE_STEMS.some(stem => mediaType.startsWith(stem))
  );
};

/** The name a `Content-Disposition` asks for: `filename*` first, then the plain quoted or bare `filename`. */
const dispositionName = (disposition: string): string | undefined => {
  const extended = /filename\*=(?:[^']*'[^']*')?([^;]+)/iu.exec(disposition)?.[1];
  const plain =
    /filename="([^"]*)"/iu.exec(disposition)?.[1] ?? /filename=([^;]+)/iu.exec(disposition)?.[1];
  const named = (extended ?? plain ?? '').trim().replaceAll(/^"|"$/gu, '');

  if (named === '') {
    return undefined;
  }

  try {
    return decodeURIComponent(named);
  } catch {
    // A name that is not valid percent-encoding is still the name the browser asked for.
    return named;
  }
};

/** The file name a paused response asks for: its `Content-Disposition`, else its url's last segment. */
export const downloadResponseName = (pause: DownloadResponsePause): string => {
  const named = dispositionName(pause.disposition ?? '');

  if (named !== undefined) {
    return named;
  }

  try {
    const last = new URL(pause.url).pathname.split('/').findLast(Boolean);

    return last === undefined ? 'the downloaded file' : decodeURIComponent(last);
  } catch {
    return 'the downloaded file';
  }
};
