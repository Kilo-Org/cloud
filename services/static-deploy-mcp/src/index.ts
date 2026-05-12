import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toFetchResponse, toReqRes } from 'fetch-to-node';
import { z } from 'zod';
import { verifyKiloToken } from '@kilocode/worker-utils';
import { tarGzFromHtml, tarGzFromZip } from './archive.js';
import { BuilderClient } from './builder-client.js';

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/** Generates a random, URL-safe deployment slug: ksd-<12 alphanumeric chars> */
function generateSlug(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = crypto.getRandomValues(new Uint8Array(12));
  const suffix = Array.from(random)
    .map(b => chars[b % chars.length])
    .join('');
  return `ksd-${suffix}`;
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function createMCPServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'kilo-static-deploy',
    version: '1.0.0',
  });

  const builder = new BuilderClient(env.BUILDER_URL, env.BUILDER_AUTH_TOKEN);
  const hostnameBase = env.DEPLOY_HOSTNAME_BASE ?? 'd.kiloapps.io';

  // ── Tool: deploy_static_site ─────────────────────────────────────────────

  server.tool(
    'deploy_static_site',
    `Deploy a static site and get back a public URL.

Accepts either:
- A raw HTML string (content_type = "html") — deployed as a single index.html page.
- A base64-encoded ZIP archive (content_type = "zip") — must contain index.html at the root.

Only static sites are supported (HTML, CSS, JS, images, fonts, etc.).
Server-side files (.php, .py, .rb, etc.) are rejected.

Returns a deployment_id for polling and the eventual public URL.
The site may take 30–90 seconds to become live; use check_deployment_status to confirm.`,
    {
      content_type: z
        .enum(['html', 'zip'])
        .describe('"html" for a raw HTML string; "zip" for a base64-encoded ZIP archive'),
      content: z
        .string()
        .describe(
          'For "html": the full HTML string to deploy. ' +
            'For "zip": base64-encoded ZIP archive containing index.html.'
        ),
    },
    async ({ content_type, content }) => {
      let archive: Uint8Array;
      try {
        if (content_type === 'html') {
          archive = await tarGzFromHtml(content);
        } else {
          archive = await tarGzFromZip(content);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to prepare archive: ${msg}` }],
          isError: true,
        };
      }

      const slug = generateSlug();
      const url = `https://${slug}.${hostnameBase}`;

      let result: Awaited<ReturnType<BuilderClient['deployArchive']>>;
      try {
        result = await builder.deployArchive(slug, archive);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Deployment request failed: ${msg}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              deployment_id: result.buildId,
              url,
              slug,
              status: result.status,
              message: 'Deployment started. Use check_deployment_status to wait for it to go live.',
            }),
          },
        ],
      };
    }
  );

  // ── Tool: check_deployment_status ────────────────────────────────────────

  server.tool(
    'check_deployment_status',
    `Check the status of a deployment started by deploy_static_site.

Poll until status is "deployed" (success) or "failed"/"cancelled" (error).
When deployed, the url field contains the live URL of the site.`,
    {
      deployment_id: z.string().describe('The deployment_id returned by deploy_static_site'),
    },
    async ({ deployment_id }) => {
      let statusResp: Awaited<ReturnType<BuilderClient['getBuildStatus']>>;
      try {
        statusResp = await builder.getBuildStatus(deployment_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to retrieve deployment status: ${msg}`,
            },
          ],
          isError: true,
        };
      }

      const isLive = statusResp.status === 'deployed';
      const isFailed = statusResp.status === 'failed' || statusResp.status === 'cancelled';

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              status: statusResp.status,
              project_type: statusResp.projectType,
              message: isLive
                ? 'Site is live.'
                : isFailed
                  ? 'Deployment failed. Check builder logs for details.'
                  : 'Deployment is still in progress. Poll again in a few seconds.',
            }),
          },
        ],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

function jsonError(message: string, status: number): Response {
  return withCors(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only POST for Streamable HTTP transport
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Validate Kilo JWT
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonError('Missing or invalid Authorization header', 401);
    }

    const secret = await env.NEXTAUTH_SECRET.get();
    if (!secret) {
      return jsonError('Server misconfiguration: secret not available', 500);
    }

    try {
      await verifyKiloToken(authHeader.slice(7), secret);
    } catch {
      return jsonError('Invalid or expired token', 401);
    }

    // Create a per-request, stateless MCP server
    const server = createMCPServer(env);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    const { req, res } = toReqRes(request);
    await transport.handleRequest(req, res);
    return withCors(await toFetchResponse(res));
  },
} satisfies ExportedHandler<Env>;
