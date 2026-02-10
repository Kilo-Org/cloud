/**
 * HTMLRewriter-based banner injection for deployed sites.
 * Injects a "Made with Kilo App Builder" badge in the bottom-right corner.
 */

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
  return `${value} ${nonceValue}`;
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
    const spaceIndex = directive.indexOf(' ');
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

  const result: string[] = [];
  for (const [name, value] of directiveMap) {
    result.push(value ? `${name} ${value}` : name);
  }
  return result.join('; ');
}

function getBannerScript(nonce: string): string {
  return `<script nonce="${nonce}" data-kilo-banner>
(function() {
  if (sessionStorage.getItem('kilo-banner-dismissed')) return;

  var badge = document.createElement('a');
  badge.href = 'https://kilo.ai/features/app-builder';
  badge.target = '_blank';
  badge.rel = 'noopener noreferrer';
  badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px 12px;background:#18181b;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;font-weight:500;line-height:1;border-radius:8px;border:1px solid #27272a;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,0.3);transition:opacity 0.2s;';

  var close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss badge');
  close.textContent = '\\u00D7';
  close.style.cssText = 'background:none;border:none;color:#71717a;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 4px;';

  badge.addEventListener('mouseenter', function() { badge.style.opacity = '0.9'; });
  badge.addEventListener('mouseleave', function() { badge.style.opacity = '1'; });
  close.addEventListener('mouseenter', function() { close.style.color = '#fafafa'; });
  close.addEventListener('mouseleave', function() { close.style.color = '#71717a'; });

  close.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    sessionStorage.setItem('kilo-banner-dismissed', '1');
    badge.remove();
  });

  badge.appendChild(document.createTextNode('Made with Kilo App Builder'));
  badge.appendChild(close);
  document.body.appendChild(badge);
})();
</script>`;
}

/**
 * Injects the "Made with Kilo App Builder" banner into an HTML response
 * using HTMLRewriter. Handles CSP nonce injection.
 */
export function injectBanner(response: Response): Response {
  const nonce = generateCSPNonce();
  const bannerScript = getBannerScript(nonce);

  const newHeaders = new Headers(response.headers);
  newHeaders.delete('content-length');
  // HTMLRewriter produces an uncompressed body, so the original encoding is no longer valid
  newHeaders.delete('content-encoding');

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
