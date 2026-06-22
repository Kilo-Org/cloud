import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const swaggerUiDist = require('swagger-ui-dist') as { getAbsoluteFSPath: () => string };

const assetContentTypes = {
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui.css': 'text/css; charset=utf-8',
} as const;

function contentTypeForAsset(asset: string) {
  if (asset === 'swagger-ui-bundle.js') return assetContentTypes[asset];
  if (asset === 'swagger-ui.css') return assetContentTypes[asset];
  return null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  const contentType = contentTypeForAsset(asset);

  if (!contentType) {
    return new Response('Not found', { status: 404 });
  }

  const content = await readFile(join(swaggerUiDist.getAbsoluteFSPath(), asset));

  return new Response(content, {
    headers: {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': contentType,
    },
  });
}
