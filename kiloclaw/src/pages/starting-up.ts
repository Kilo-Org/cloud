/**
 * Friendly "starting up" HTML page returned when the Fly proxy returns a 502,
 * indicating the gateway process inside the container isn't ready yet.
 * Auto-refreshes every 5 seconds so the user lands on the real UI once ready.
 */
const BASE_STYLES = /* css */ `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 1rem;
  }
  .card {
    background: #161616; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 2rem; max-width: 420px; width: 100%; text-align: center;
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.5rem; color: #fff; }
  .subtitle { font-size: 0.85rem; color: #888; margin-bottom: 1.5rem; }
  .spinner {
    width: 32px; height: 32px; margin: 0 auto 1rem;
    border: 3px solid #333; border-top-color: #888;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>KiloClaw — Starting Up</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Your instance is still starting up&hellip;</h1>
    <p class="subtitle">This page will automatically refresh. Hang tight!</p>
  </div>
</body>
</html>`;

export function startingUpPage(): Response {
  return new Response(HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Retry-After': '5' },
  });
}
