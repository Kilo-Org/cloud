import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  getVercelProviderMetadata,
  isVercelGenerationId,
  VercelProviderMetadataStorageNotConfiguredError,
} from '@kilocode/web-shared/lib/r2/vercel-provider-metadata';

/**
 * Returns the stored Vercel AI Gateway `provider_metadata` for a generation.
 * Metadata is stored best effort and expires, so a missing object is a 404.
 */
export async function handleAdminVercelProviderMetadataRequest(
  _request: Request,
  { params }: { params: Promise<{ generationId: string }> }
) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const { generationId } = await params;
  if (!isVercelGenerationId(generationId)) {
    return NextResponse.json({ error: 'Invalid generation id' }, { status: 400 });
  }

  let metadata: string | null;
  try {
    metadata = await getVercelProviderMetadata(generationId);
  } catch (error) {
    if (error instanceof VercelProviderMetadataStorageNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  if (metadata === null) {
    return NextResponse.json(
      { error: `No provider metadata stored for generation ${generationId}` },
      { status: 404 }
    );
  }

  return new Response(metadata, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
