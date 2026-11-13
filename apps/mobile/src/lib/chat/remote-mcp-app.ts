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
 * One origin a policy may name: a scheme, an exact host and an optional port.
 * Anything else — a wildcard host, a path, credentials, `'unsafe-inline'`, a
 * bare word — is dropped, because the policy is the resource's own request and
 * a request cannot widen the sandbox beyond what the host allows.
 */
const ORIGIN =
  /^(?:https?|wss?):\/\/(?:\[[0-9A-Fa-f:.]+\]|[^\s/\\@?#;,'"<>()[\]{}|^`%*:]+)(?::\d{1,5})?$/u;

const ResourceCspSchema = z.object({
  connectDomains: z.array(z.string()).optional(),
  resourceDomains: z.array(z.string()).optional(),
  frameDomains: z.array(z.string()).optional(),
  baseUriDomains: z.array(z.string()).optional(),
});

const ViewMetaSchema = z
  .object({ ui: z.object({ csp: ResourceCspSchema.optional() }).optional() })
  .optional();

/**
 * Whether a port an origin names is one a socket can have. A source with a
 * larger one names nothing a request can reach, so it is not an origin here.
 */
const portInRange = (origin: string): boolean => {
  const port = /:(\d{1,5})$/u.exec(origin)?.[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
};

/**
 * The origins a directive names, each exactly an origin. A host spelled with a
 * trailing slash is the same origin, so the slash is dropped before the test.
 */
const originsOf = (domains: readonly string[] | undefined): readonly string[] =>
  (domains ?? [])
    .map(domain => domain.replace(/\/$/u, ''))
    .filter(domain => ORIGIN.test(domain) && portInRange(domain));

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

/** A document may start with a byte-order mark, which the parser drops. */
const BYTE_ORDER_MARK = '\uFEFF';

/** The whitespace the tokenizer skips before content, and only that. */
const PROLOGUE_SPACE = /[ \t\n\f\r]*/y;

/** A doctype ends at the first `>`, whatever it names. */
const PROLOGUE_DOCTYPE = /<!doctype[^>]*>/iy;

/**
 * One comment: `<!-->` and `<!--->` close an empty comment at once, and any
 * other comment ends at the first `-->` or `--!>`.
 */
const PROLOGUE_COMMENT = /<!--(?:>|->|[\s\S]*?--!?>)/y;

/** `<?` and any `<!` that is not a doctype are bogus comments: up to the first `>`. */
const PROLOGUE_BOGUS = /<[!?][^>]*>/y;

/**
 * Where the policy goes: after the prologue the tokenizer reads before the
 * document's own content, which is after a doctype when the prologue reaches
 * one.
 *
 * Each token is consumed by the tokenizer's own rule, so a document cannot talk
 * the scan past markup. A token that ends without a terminator, or one that is
 * none of these, ends the prologue: everything from there is content. A
 * doctype past that content is a doctype the parser ignores, so it never moves
 * the policy behind the content.
 *
 * A document with no doctype keeps its byte-order mark first, because a mark
 * the policy got in front of would be read as a stray character of the document.
 */
function policyIndex(html: string): number {
  const start = html.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK.length : 0;
  let at = start;
  let doctype = start;
  let done = false;
  while (!done) {
    PROLOGUE_SPACE.lastIndex = at;
    PROLOGUE_SPACE.exec(html);
    at = PROLOGUE_SPACE.lastIndex;
    PROLOGUE_DOCTYPE.lastIndex = at;
    PROLOGUE_COMMENT.lastIndex = at;
    PROLOGUE_BOGUS.lastIndex = at;
    const held = PROLOGUE_DOCTYPE.exec(html);
    const token = held ?? PROLOGUE_COMMENT.exec(html) ?? PROLOGUE_BOGUS.exec(html);
    if (token === null) {
      done = true;
    } else {
      at = token.index + token[0].length;
      if (held !== null) {
        doctype = at;
      }
    }
  }
  return doctype;
}

/**
 * The view's HTML with its policy in front of it.
 *
 * The policy is a meta element, because the document is loaded as `srcdoc`
 * with no headers of its own. It goes before everything the resource wrote, and
 * after the resource's doctype when the parser honours one, so:
 *
 * - the parser reads the meta while it is still building the head, which puts
 *   the meta in the head of the document it draws;
 * - the doctype keeps its place, so a document that declared one is drawn in
 *   standards mode;
 * - a document with no head is still a document the parser gives one, with the
 *   policy already in it.
 *
 * The resource's own markup cannot move the policy behind any of it: the
 * insertion point is the prologue the tokenizer actually reads, so text that
 * looks like a head or a doctype inside a comment, a script or an attribute is
 * never mistaken for one.
 */
export function viewDocument(html: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}">`;
  const at = policyIndex(html);
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
