import { z } from 'zod';

/**
 * The document one MCP Apps view is drawn from, and the sandbox it is drawn in.
 *
 * The resource's HTML comes from somebody else's server, so it is treated as
 * hostile: it runs in an iframe with an opaque origin, with no file access, no
 * way to navigate the page around it, and a policy built only from what the
 * server declared — and from nothing when it declared nothing.
 */

/** The height a transcript row gives a view before the view reports its own. */
export const DEFAULT_VIEW_HEIGHT = 240;

/** The tallest a view may draw itself in a transcript row. */
export const MAX_VIEW_HEIGHT = 520;

/** The shortest a view may draw itself in a transcript row. */
const MIN_VIEW_HEIGHT = 120;

/**
 * The view's reported height inside the box a transcript row may take, so a
 * view that reports nothing, or reports a page's height, keeps the transcript
 * where it was.
 */
export function viewHeightOf(reported: number | undefined): number {
  const height = reported === undefined ? DEFAULT_VIEW_HEIGHT : Math.ceil(reported);
  return Math.min(MAX_VIEW_HEIGHT, Math.max(MIN_VIEW_HEIGHT, height));
}

/**
 * The arguments the view is handed: the model's, without the field the harness
 * adds to every call. The view is told what the server was called with, which
 * is what the server itself read.
 */
export function viewArguments(input: Readonly<Record<string, unknown>>) {
  const arguments_ = { ...input };
  delete arguments_.wait;
  return arguments_;
}

/**
 * The largest view the sandbox takes. The HTML is handed to the page as a
 * JavaScript string, so a document far larger than a UI is not one; it is
 * refused rather than turned into a bridge message.
 */
export const MAX_VIEW_BYTES = 1_000_000;

/**
 * One origin a policy may name. Anything else — a wildcard, `'unsafe-inline'`,
 * a bare word — is dropped, because the policy is the resource's own request
 * and a request cannot widen the sandbox beyond what the host allows.
 */
const ORIGIN = /^(?:https?|wss?):\/\/[^\s;'"<>]+$/u;

const ResourceCspSchema = z.object({
  connectDomains: z.array(z.string()).optional(),
  resourceDomains: z.array(z.string()).optional(),
  frameDomains: z.array(z.string()).optional(),
  baseUriDomains: z.array(z.string()).optional(),
});

const ViewMetaSchema = z
  .object({ ui: z.object({ csp: ResourceCspSchema.optional() }).optional() })
  .optional();

const originsOf = (domains: readonly string[] | undefined): readonly string[] =>
  (domains ?? []).filter(domain => ORIGIN.test(domain));

/** The policy tokens for one directive: the named origins, or nothing. */
const tokensFor = (origins: readonly string[]): string =>
  origins.length === 0 ? "'none'" : origins.join(' ');

/**
 * The policy the view runs under: nothing by default, and only the origins the
 * resource declared for the one kind of load it named.
 *
 * `'unsafe-inline'` is allowed for scripts and styles because a view is one
 * document with its own code in it, and it has nowhere to fetch code from
 * unless the resource named a host for it. Inline code in a document with no
 * same-origin access and no navigation is the shape the Apps specification
 * expects a view to have.
 */
export function contentSecurityPolicy(meta: Readonly<Record<string, unknown>> | undefined): string {
  // Metadata that is not the shape the specification defines gets the
  // default policy rather than an error: a resource with no readable policy is
  // a resource with nothing it may load.
  const csp = ViewMetaSchema.safeParse(meta).data?.ui?.csp;
  const resources = originsOf(csp?.resourceDomains);
  const connections = originsOf(csp?.connectDomains);
  const frames = originsOf(csp?.frameDomains);
  const bases = originsOf(csp?.baseUriDomains);
  const inline = "'unsafe-inline'";
  return [
    "default-src 'none'",
    `script-src ${[inline, ...resources].join(' ')}`,
    `style-src ${[inline, ...resources].join(' ')}`,
    `img-src ${[...resources, 'data:'].join(' ')}`,
    `font-src ${[...resources, 'data:'].join(' ')}`,
    `media-src ${[...resources, 'data:'].join(' ')}`,
    `connect-src ${tokensFor(connections)}`,
    `frame-src ${tokensFor(frames)}`,
    `base-uri ${tokensFor(bases)}`,
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * The view's HTML with its policy in front of it.
 *
 * The policy is a meta element, because the document is loaded as `srcdoc`
 * with no headers of its own. It goes first in the head, before the resource's
 * own tags, so nothing in the document can run before it applies.
 */
export function viewDocument(html: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}">`;
  const head = /<head[^>]*>/iu.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${meta}${html.slice(at)}`;
  }
  /* A document without a head still gets its policy before its own content, and
     after the doctype when it has one: a start tag in front of the doctype is
     a parse error, and the parser then draws the whole document in quirks
     mode. The parser hoists the meta into the head it makes. */
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  const at = doctype === null ? 0 : doctype.index + doctype[0].length;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

/**
 * The app's page: the one document the WebView loads.
 *
 * It owns the sandboxed iframe the view runs in and nothing else. The view is
 * `sandbox="allow-scripts"` — an opaque origin, no file access, no way to
 * navigate this page or read it — and its traffic crosses in both directions as
 * JSON text: the host's messages are posted into the iframe, and only that
 * iframe's own messages are handed back to the app. A message from anywhere
 * else on this page is dropped.
 *
 * The names are the seam the app calls: `window.kiloMcpHost.mount(html)` puts a
 * document in the sandbox, and `window.kiloMcpHost.deliver(text)` posts one
 * bridge message into it.
 */
export const VIEW_HOST_PAGE = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
#view{display:block;width:100%;height:100%;border:0;background:transparent;}
</style></head><body><iframe id="view" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
const view = document.getElementById('view');
const post = text => window.ReactNativeWebView.postMessage(text);
window.kiloMcpHost = {
  mount: html => { view.srcdoc = html; },
  deliver: text => {
    if (view.contentWindow) {
      view.contentWindow.postMessage(JSON.parse(text), '*');
    }
  },
};
window.addEventListener('message', event => {
  if (event.source !== view.contentWindow) return;
  post(typeof event.data === 'string' ? event.data : JSON.stringify(event.data));
});
</script></body></html>`;
