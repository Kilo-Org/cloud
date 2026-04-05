/**
 * Static Site Worker - Serves static assets from the ASSETS binding
 *
 * Features:
 * - Direct asset serving from ASSETS binding
 * - Clean URL support (/path -> /path/index.html)
 * - SPA fallback routing (serves index.html for 404s on HTML requests)
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Try to serve the asset directly
    let response = await env.ASSETS.fetch(request);

    // If found, return it
    if (response.status !== 404) {
      return response;
    }

    // Try clean URL: /path -> /path/index.html
    if (!url.pathname.endsWith('/') && !url.pathname.includes('.')) {
      const cleanUrlRequest = new Request(new URL(url.pathname + '/index.html', url), request);
      const cleanUrlResponse = await env.ASSETS.fetch(cleanUrlRequest);
      if (cleanUrlResponse.status === 200) {
        return cleanUrlResponse;
      }
    }

    // Handle SPA routing: serve index.html for 404s on HTML requests
    const acceptHeader = request.headers.get('Accept') || '';
    if (acceptHeader.includes('text/html')) {
      const indexRequest = new Request(new URL('/index.html', url), request);
      const indexResponse = await env.ASSETS.fetch(indexRequest);
      if (indexResponse.status === 200) {
        return indexResponse;
      }
    }

    // Return original 404 response
    return response;
  },
};
