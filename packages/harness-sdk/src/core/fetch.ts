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

interface HttpRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type FetchLike = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export type { FetchLike, HttpRequest, HttpResponse };
