/**
 * The smallest part of `fetch` the package uses. The package declares it rather
 * than pulling in the DOM library, so the core keeps running on Node, in a
 * browser, and in a mobile app. The caller adapts its own `fetch`.
 */
interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
  /** Decoded body chunks. A caller that streams must supply this. */
  readonly stream?: () => AsyncIterable<string>;
}

/**
 * The signal a runtime's `AbortController` produces.
 *
 * The package declares it rather than pulling in the DOM library, and never
 * reads it: it makes one per call and hands it over, so that a caller who stops
 * listening stops the request as well. An adapter that calls the platform
 * `fetch` names the type it has, as `request.signal as AbortSignal | undefined`.
 */
interface AbortLike {
  readonly aborted: boolean;
}

interface HttpRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * Aborted when the caller stops reading. Absent when the runtime has no
   * `AbortController`, in which case a call cannot be stopped early.
   */
  readonly signal?: AbortLike;
}

type FetchLike = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export type { AbortLike, FetchLike, HttpRequest, HttpResponse };
