const swaggerUiHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kilo Code API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.32.7/swagger-ui.css" />
    <style>
      :root {
        color-scheme: dark;
        --kilo-background: #171717;
        --kilo-surface: #222222;
        --kilo-foreground: #fafafa;
        --kilo-muted: #b4b4b4;
        --kilo-primary: #edff00;
      }

      body {
        margin: 0;
        background: var(--kilo-background);
      }

      .kilo-docs-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 24px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        background: var(--kilo-surface);
        color: var(--kilo-foreground);
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }

      .kilo-docs-title {
        margin: 0;
        font-size: 16px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }

      .kilo-docs-subtitle {
        margin: 4px 0 0;
        color: var(--kilo-muted);
        font-size: 13px;
      }

      .kilo-docs-link {
        border-radius: 6px;
        background: var(--kilo-primary);
        color: #171717;
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        white-space: nowrap;
      }

      #swagger-ui {
        background: #ffffff;
        min-height: calc(100vh - 73px);
      }
    </style>
  </head>
  <body>
    <header class="kilo-docs-header">
      <div>
        <h1 class="kilo-docs-title">Kilo Code API Docs</h1>
        <p class="kilo-docs-subtitle">Swagger UI generated from the allowlisted tRPC OpenAPI document.</p>
      </div>
      <a class="kilo-docs-link" href="/api/openapi.json">Open JSON</a>
    </header>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.32.7/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/api/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>`;

export function GET() {
  return new Response(swaggerUiHtml, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
}
