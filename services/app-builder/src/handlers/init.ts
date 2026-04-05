/**
 * Init endpoint handler
 * POST /apps/{app-id}/init
 *
 * Initializes a new repository using a NextJS template stored in R2.
 */

import { logger, formatError } from '../utils/logger';
import { verifyBearerToken } from '../utils/auth';
import type { Env } from '../types';
import { InitRequestSchema } from '../api-schemas';

const DEFAULT_TEMPLATE = 'nextjs-starter';

/**
 * Extract files from a TAR archive stream
 * TAR format: 512-byte header blocks followed by file content (padded to 512 bytes)
 * Returns files with base64-encoded content to safely handle binary files through RPC
 */
async function extractTar(tarStream: ReadableStream<Uint8Array>): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const reader = tarStream.getReader();

  // Collect all data from the stream
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  // Concatenate all chunks into a single buffer
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  // Parse TAR format
  let position = 0;
  const textDecoder = new TextDecoder('utf-8');

  while (position + 512 <= buffer.length) {
    // Read 512-byte header
    const header = buffer.slice(position, position + 512);

    // Check for end of archive (two consecutive zero blocks)
    if (header.every(byte => byte === 0)) {
      break;
    }

    // Extract filename (bytes 0-99, null-terminated)
    let filenameEnd = 0;
    while (filenameEnd < 100 && header[filenameEnd] !== 0) {
      filenameEnd++;
    }
    let filename = textDecoder.decode(header.slice(0, filenameEnd)).trim();

    // Normalize path: strip leading './' prefix
    if (filename.startsWith('./')) {
      filename = filename.slice(2);
    }

    // Get the base filename for filtering
    const baseName = filename.split('/').pop() || '';

    // Skip macOS resource fork files (._*)
    if (baseName.startsWith('._')) {
      // Skip content blocks for this entry
      const sizeStr = textDecoder.decode(header.slice(124, 136)).trim();
      const skipSize = parseInt(sizeStr, 8) || 0;
      position += 512; // Move past header
      const contentBlocks = Math.ceil(skipSize / 512);
      position += contentBlocks * 512;
      continue;
    }

    // Extract file size (bytes 124-135, octal string)
    const sizeStr = textDecoder.decode(header.slice(124, 136)).trim();
    const fileSize = parseInt(sizeStr, 8) || 0;

    // Extract type flag (byte 156)
    const typeFlag = header[156];

    // Move past header
    position += 512;

    // Skip if not a regular file (typeFlag 0 or ASCII '0')
    if (typeFlag !== 0 && typeFlag !== 48) {
      // Skip content blocks for this entry
      const contentBlocks = Math.ceil(fileSize / 512);
      position += contentBlocks * 512;
      continue;
    }

    // Skip empty files or directories
    if (fileSize === 0 || !filename || filename.endsWith('/')) {
      continue;
    }

    // Read file content
    const content = buffer.slice(position, position + fileSize);

    // Store file content as base64 to safely handle binary files through RPC
    let binaryString = '';
    for (let i = 0; i < content.length; i++) {
      binaryString += String.fromCharCode(content[i]);
    }
    files[filename] = btoa(binaryString);

    // Move past content (padded to 512-byte boundary)
    const contentBlocks = Math.ceil(fileSize / 512);
    position += contentBlocks * 512;
  }

  return files;
}

/**
 * Handle POST /apps/{app-id}/init request
 *
 * Flow:
 * 1. Verify Bearer token authentication
 * 2. Check if repository already exists
 * 3. Fetch and extract template TAR archive from R2
 * 4. Initialize repository and create initial commit
 * 5. Return success with git URL
 */
export async function handleInit(request: Request, env: Env, appId: string): Promise<Response> {
  try {
    const authResult = verifyBearerToken(request, env);
    if (!authResult.isAuthenticated) {
      if (!authResult.errorResponse) {
        return new Response('Unauthorized', { status: 401 });
      }
      return authResult.errorResponse;
    }

    const id = env.GIT_REPOSITORY.idFromName(appId);
    const stub = env.GIT_REPOSITORY.get(id);

    const isInitialized = await stub.isInitialized();

    if (isInitialized) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'repository_exists',
          message: `Repository '${appId}' already exists`,
          git_url: `https://${env.BUILDER_HOSTNAME}/apps/${appId}.git`,
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Parse request body for optional template name
    let templateName = DEFAULT_TEMPLATE;

    const text = await request.text();
    // Handle empty body gracefully (old clients sent Content-Type without body)
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'invalid_request',
            message: 'Invalid JSON',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      const result = InitRequestSchema.safeParse(body);
      if (!result.success) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'invalid_request',
            message: result.error.issues[0]?.message ?? 'Invalid request body',
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      if (result.data.template) {
        templateName = result.data.template;
      }
    }

    // Initial template for the project
    const templatePath = `templates/${templateName}.tar.gz`;
    const tarObject = await env.TEMPLATES.get(templatePath);

    if (!tarObject) {
      logger.error('Template archive not found', {
        path: templatePath,
        template: templateName,
        appId,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'template_not_found',
          message: `Template '${templateName}' not found in R2 storage`,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Decompress gzip and extract TAR
    const decompressedStream = tarObject.body.pipeThrough(new DecompressionStream('gzip'));
    const files = await extractTar(decompressedStream);

    if (Object.keys(files).length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'template_empty',
          message: 'No files found in template archive',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    logger.info('Extracted template files', { fileCount: Object.keys(files).length });

    await stub.createInitialCommit(files);

    const previewId = env.PREVIEW.idFromName(appId);
    const previewStub = env.PREVIEW.get(previewId);
    await previewStub.initWithAppId(appId);

    logger.info('Initialized preview');

    // triggerBuild() returns quickly as it uses ctx.waitUntil() internally,
    // but we must await it to ensure the RPC call reaches the DO before
    // the worker terminates
    try {
      await previewStub.triggerBuild();
    } catch (error) {
      // Log error but don't fail the init
      logger.error('Failed to trigger preview build', formatError(error));
    }

    return new Response(
      JSON.stringify({
        success: true,
        app_id: appId,
        git_url: `https://${env.BUILDER_HOSTNAME}/apps/${appId}.git`,
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    logger.error('Init handler error', formatError(error));
    return new Response(
      JSON.stringify({
        success: false,
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
