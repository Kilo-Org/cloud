/**
 * HTMLRewriter-based banner injection for deployed sites.
 * Injects a "Made with Kilo" badge in the bottom-right corner
 * inside an iframe for complete style isolation from the host page.
 */

const KILO_APP_BUILDER_URL = 'https://app.kilo.ai/app-builder';

/**
 * Generates a cryptographically secure base64-encoded nonce for CSP.
 * Uses 16 random bytes (128 bits) encoded as base64.
 */
function generateCSPNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Adds a nonce to a CSP directive value.
 * Handles the special case where 'none' is present (must be replaced, not appended).
 */
function addNonceToDirective(value: string, nonceValue: string): string {
  if (value.includes("'none'")) {
    return value.replace("'none'", nonceValue);
  }
  return value ? `${value} ${nonceValue}` : nonceValue;
}

/**
 * Adds a nonce to the script-src directive of a CSP header.
 * Also updates script-src-elem if present (since it takes precedence for <script> tags).
 * If script-src doesn't exist, creates it based on default-src.
 */
function addNonceToCSP(csp: string, nonce: string): string {
  const nonceValue = `'nonce-${nonce}'`;
  const directives = csp
    .split(';')
    .map(d => d.trim())
    .filter(Boolean);

  const directiveMap = new Map<string, string>();
  for (const directive of directives) {
    const spaceIndex = directive.search(/\s/);
    if (spaceIndex === -1) {
      directiveMap.set(directive.toLowerCase(), '');
    } else {
      const name = directive.slice(0, spaceIndex).toLowerCase();
      const value = directive.slice(spaceIndex + 1);
      directiveMap.set(name, value);
    }
  }

  if (directiveMap.has('script-src')) {
    const current = directiveMap.get('script-src') ?? '';
    directiveMap.set('script-src', addNonceToDirective(current, nonceValue));
  } else if (directiveMap.has('default-src')) {
    const defaultSrc = directiveMap.get('default-src') ?? '';
    directiveMap.set('script-src', addNonceToDirective(defaultSrc, nonceValue));
  } else {
    directiveMap.set('script-src', nonceValue);
  }

  if (directiveMap.has('script-src-elem')) {
    const current = directiveMap.get('script-src-elem') ?? '';
    directiveMap.set('script-src-elem', addNonceToDirective(current, nonceValue));
  }

  // Ensure frame-src (or child-src) allows our srcdoc iframe.
  // Only needed when the directive is explicitly present and restrictive.
  for (const directive of ['frame-src', 'child-src']) {
    if (directiveMap.has(directive)) {
      const current = directiveMap.get(directive) ?? '';
      if (!current.includes("'self'") && !current.includes('*')) {
        directiveMap.set(directive, addNonceToDirective(current, "'self'"));
      }
    }
  }

  const result: string[] = [];
  for (const [name, value] of directiveMap) {
    result.push(value ? `${name} ${value}` : name);
  }
  return result.join('; ');
}

const KILO_LOGO_SVG =
  '<svg width="24" height="24" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="512" height="512" rx="80" fill="#18181b"/>' +
  '<path d="M322 377H377V421H307.857L278 391.143V322H322V377Z' +
  'M421 307.857L391.143 278H322V322L377 322V377H421V307.857Z' +
  'M234 278H190V322H234V278Z' +
  'M91 391.143L120.857 421H234V377H135V278H91V391.143Z' +
  'M371.172 189.999V120.856L341.315 90.9995H278V135H327.172V189.999H278V233.999H421V189.999H371.172Z' +
  'M135 91H91V233.999H135V184.5H190V233.999H234V184.5L190 140.5H135V91Z' +
  'M234 91H190V140.5H234V91Z" fill="#FAF74F"/>' +
  '</svg>';

function getBannerScript(nonce: string): string {
  const srcdoc =
    '<!DOCTYPE html>' +
    '<html><head><style>' +
    'body { margin: 0; background: transparent; display: flex; justify-content: center; }' +
    'a {' +
    '  display: inline-flex;' +
    '  align-items: center;' +
    '  gap: 8px;' +
    '  padding: 6px 12px 6px 6px;' +
    '  background: rgba(24,24,27,0.85);' +
    '  color: #fafafa;' +
    '  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
    '  border-radius: 10px;' +
    '  border: 1px solid rgba(255,255,255,0.08);' +
    '  text-decoration: none;' +
    '  box-shadow: 0 4px 12px rgba(0,0,0,0.4);' +
    '  backdrop-filter: blur(12px);' +
    '  -webkit-backdrop-filter: blur(12px);' +
    '  transition: transform 0.2s, box-shadow 0.2s;' +
    '}' +
    'a:hover {' +
    '  transform: translateY(-1px);' +
    '  box-shadow: 0 6px 16px rgba(0,0,0,0.5);' +
    '}' +
    'svg { flex-shrink: 0; border-radius: 6px; }' +
    '</style></head><body>' +
    '<a href="' +
    KILO_APP_BUILDER_URL +
    '" target="_blank" rel="noopener noreferrer">' +
    KILO_LOGO_SVG +
    '<span>Made with Kilo</span>' +
    '</a></body></html>';

  // JSON.stringify handles all JS-string escaping (quotes, backslashes, backticks, ${, etc.).
  // setAttribute then handles HTML-attribute escaping at runtime.
  const srcdocJs = JSON.stringify(srcdoc);

  return `<script nonce="${nonce}" data-kilo-banner>
(function() {
  function inject() {
    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;border:none;width:195px;height:38px;overflow:hidden;pointer-events:auto;color-scheme:none;background:transparent;';
    iframe.setAttribute('srcdoc', ${srcdocJs});
    iframe.setAttribute('title', 'Made with Kilo');
    iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    document.body.appendChild(iframe);
  }
  if (document.body) { inject(); }
  else { document.addEventListener('DOMContentLoaded', inject); }
})();
</script>`;
}

/**
 * Injects the "Made with Kilo" banner into an HTML response
 * using HTMLRewriter. Handles CSP nonce injection.
 */
export function injectBanner(response: Response): Response {
  const nonce = generateCSPNonce();
  const bannerScript = getBannerScript(nonce);

  const newHeaders = new Headers(response.headers);
  newHeaders.delete('content-length');
  // HTMLRewriter produces an uncompressed body, so the original encoding is no longer valid
  newHeaders.delete('content-encoding');
  // Validators no longer match the rewritten body
  newHeaders.delete('etag');
  newHeaders.delete('last-modified');

  // Modify CSP headers to allow our nonced script
  const csp = response.headers.get('content-security-policy');
  if (csp) {
    newHeaders.set('content-security-policy', addNonceToCSP(csp, nonce));
  }
  const cspReportOnly = response.headers.get('content-security-policy-report-only');
  if (cspReportOnly) {
    newHeaders.set('content-security-policy-report-only', addNonceToCSP(cspReportOnly, nonce));
  }

  let injected = false;

  const rewriter = new HTMLRewriter()
    .on('head', {
      element(element) {
        if (!injected) {
          element.append(bannerScript, { html: true });
          injected = true;
        }
      },
    })
    .on('body', {
      element(element) {
        if (!injected) {
          element.prepend(bannerScript, { html: true });
          injected = true;
        }
      },
    })
    .onDocument({
      end(end) {
        if (!injected) {
          end.append(bannerScript, { html: true });
        }
      },
    });

  const transformedResponse = rewriter.transform(response);
  return new Response(transformedResponse.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
