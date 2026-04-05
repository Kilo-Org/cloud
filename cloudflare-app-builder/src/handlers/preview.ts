import { logger, formatError } from '../utils/logger';
import { verifyBearerToken } from '../utils/auth';
import { DEFAULT_SANDBOX_PORT, type Env } from '../types';
import type { PreviewDO } from '../preview-do';
import { getSandbox } from '@cloudflare/sandbox';
import { switchPort } from '@cloudflare/containers';

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
  // If directive contains 'none', replace it with the nonce (since 'none' must be alone)
  if (value.includes("'none'")) {
    return value.replace("'none'", nonceValue);
  }
  return `${value} ${nonceValue}`;
}

/**
 * Adds a nonce to the script-src directive of a CSP header.
 * Also updates script-src-elem if present (since it takes precedence for <script> tags).
 * If script-src doesn't exist, creates it based on default-src.
 * Handles 'none' by replacing it (since 'none' cannot be combined with other sources).
 * Returns the modified CSP string.
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
    // Create script-src from default-src and add nonce
    const defaultSrc = directiveMap.get('default-src') ?? '';
    directiveMap.set('script-src', addNonceToDirective(defaultSrc, nonceValue));
  } else {
    // No script-src or default-src, add script-src with nonce
    directiveMap.set('script-src', nonceValue);
  }

  // Also update script-src-elem if present (takes precedence over script-src for <script> tags)
  if (directiveMap.has('script-src-elem')) {
    const current = directiveMap.get('script-src-elem') ?? '';
    directiveMap.set('script-src-elem', addNonceToDirective(current, nonceValue));
  }

  // Reconstruct CSP string
  const result: string[] = [];
  for (const [name, value] of directiveMap) {
    result.push(value ? `${name} ${value}` : name);
  }
  return result.join('; ');
}

/**
 * Generates the bridge script tag with the given nonce for CSP compliance.
 * The script enables URL tracking by sending navigation events to the parent window.
 * Validates message origins before navigating to prevent unauthorized control.
 */
function getPreviewBridgeScript(nonce: string): string {
  return `<script nonce="${nonce}" data-kilo-preview-bridge>
(function() {
  var send = function() {
    window.parent.postMessage({
      type: 'kilo-preview-navigation',
      url: window.location.href,
      pathname: window.location.pathname
    }, '*');
  };
  send();
  var wrap = function(fn) {
    return function() {
      var result = fn.apply(this, arguments);
      send();
      return result;
    };
  };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener('popstate', send);
  window.addEventListener('message', function(e) {
    // Validate origin: only accept navigation commands from the parent window
    // and only navigate to URLs on the same origin as the current page
    if (e.data && e.data.type === 'kilo-preview-navigate' && e.source === window.parent) {
      try {
        var targetUrl = new URL(e.data.url);
        if (targetUrl.origin === window.location.origin) {
          window.location.href = e.data.url;
        }
      } catch (err) {
        // Invalid URL, ignore
      }
    }
  });
})();
</script>`;
}

function getPreviewDO(appId: string, env: Env): DurableObjectStub<PreviewDO> {
  const id = env.PREVIEW.idFromName(appId);
  return env.PREVIEW.get(id);
}

export async function handleGetPreviewStatus(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  try {
    // 1. Verify Bearer token authentication
    const authResult = verifyBearerToken(request, env);
    if (!authResult.isAuthenticated) {
      if (!authResult.errorResponse) {
        return new Response('Unauthorized', { status: 401 });
      }
      return authResult.errorResponse;
    }

    const previewStub = getPreviewDO(appId, env);
    const { state, error } = await previewStub.getStatus();

    // In dev mode, return URL without subdomain (worker routes based on last accessed project)
    const previewUrl =
      state === 'running'
        ? env.DEV_MODE
          ? `https://${env.BUILDER_HOSTNAME}`
          : `https://${appId}.${env.BUILDER_HOSTNAME}`
        : null;

    return new Response(
      JSON.stringify({
        status: state,
        previewUrl,
        error,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    logger.error('Preview status error', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleTriggerBuild(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  try {
    // 1. Verify Bearer token authentication
    const authResult = verifyBearerToken(request, env);
    if (!authResult.isAuthenticated) {
      if (!authResult.errorResponse) {
        return new Response('Unauthorized', { status: 401 });
      }
      return authResult.errorResponse;
    }

    const previewStub = getPreviewDO(appId, env);
    await previewStub.triggerBuild();

    return new Response('', {
      status: 202, // Accepted - build is running asynchronously
    });
  } catch (error) {
    logger.error('Trigger build error', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handleStreamBuildLogs(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  try {
    // 1. Verify Bearer token authentication
    const authResult = verifyBearerToken(request, env);
    if (!authResult.isAuthenticated) {
      if (!authResult.errorResponse) {
        return new Response('Unauthorized', { status: 401 });
      }
      return authResult.errorResponse;
    }

    const previewStub = getPreviewDO(appId, env);
    const logStream = await previewStub.streamBuildLogs();

    if (!logStream) {
      return new Response(
        JSON.stringify({
          error: 'no_logs_available',
          message: 'No build process is currently running or process ID not available',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Return the stream as Server-Sent Events
    return new Response(logStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    logger.error('Stream build logs error', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export async function handlePreviewProxy(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  try {
    const sandbox = getSandbox(env.SANDBOX, appId);

    // Detect WebSocket upgrade request
    const upgradeHeader = request.headers.get('Upgrade');
    const isWebSocket = upgradeHeader?.toLowerCase() === 'websocket';

    const url = new URL(request.url);

    const port = DEFAULT_SANDBOX_PORT;
    const proxyUrl = new URL(request.url);
    proxyUrl.hostname = 'localhost';
    proxyUrl.port = String(port);
    proxyUrl.protocol = 'http:';

    if (isWebSocket) {
      // WebSocket: Use sandbox.fetch() with switchPort
      const wsRequest = new Request(proxyUrl, request);
      try {
        const response = await sandbox.fetch(switchPort(wsRequest, port));
        return response;
      } catch (error) {
        logger.error('WebSocket proxy error', formatError(error));
        return new Response(
          JSON.stringify({
            error: 'proxy_error',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
          {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // Regular HTTP: Use containerFetch
    const clonedRequest = request.clone();
    const proxyRequest = new Request(proxyUrl, {
      method: clonedRequest.method,
      headers: clonedRequest.headers,
      body: clonedRequest.body,
      // @ts-expect-error - duplex required for body streaming in modern runtimes
      duplex: 'half',
    });

    // Add forwarding headers
    proxyRequest.headers.set('X-Original-URL', request.url);
    proxyRequest.headers.set('X-Forwarded-Host', url.hostname);
    proxyRequest.headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    proxyRequest.headers.set('X-App-Id', appId);

    try {
      const response = await sandbox.containerFetch(proxyRequest, port);

      // Inject preview bridge script into HTML responses for URL tracking
      // Uses HTMLRewriter for streaming transformation (avoids buffering entire response)
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('text/html')) {
        // Generate a base64 nonce for CSP-safe script injection
        const nonce = generateCSPNonce();
        const bridgeScript = getPreviewBridgeScript(nonce);

        const newHeaders = new Headers(response.headers);
        newHeaders.delete('content-length');
        newHeaders.delete('content-encoding');

        // Modify CSP headers to allow our nonced script
        const csp = response.headers.get('content-security-policy');
        if (csp) {
          newHeaders.set('content-security-policy', addNonceToCSP(csp, nonce));
        }
        const cspReportOnly = response.headers.get('content-security-policy-report-only');
        if (cspReportOnly) {
          newHeaders.set(
            'content-security-policy-report-only',
            addNonceToCSP(cspReportOnly, nonce)
          );
        }

        // Track whether we've injected the script (only inject once)
        let injected = false;

        const rewriter = new HTMLRewriter()
          // Prefer injecting at end of <head> (best practice for scripts)
          .on('head', {
            element(element) {
              if (!injected) {
                element.append(bridgeScript, { html: true });
                injected = true;
              }
            },
          })
          // Fallback: inject at start of <body> if no <head>
          .on('body', {
            element(element) {
              if (!injected) {
                element.prepend(bridgeScript, { html: true });
                injected = true;
              }
            },
          })
          // Final fallback: append to document end if no <head> or <body>
          .onDocument({
            end(end) {
              if (!injected) {
                end.append(bridgeScript, { html: true });
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

      return response;
    } catch (error) {
      logger.error('Container proxy error', formatError(error));
      return new Response(
        JSON.stringify({
          error: 'proxy_error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  } catch (error) {
    logger.error('Preview proxy error', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'proxy_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
