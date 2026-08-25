import { getUserFromAuth } from '@/lib/user/server';
import { fetchSafeMedia } from '@/lib/media-proxy';
import { NextResponse, type NextRequest } from 'next/server';

// Compatibility: old mobile clients still fetch the source URI directly. Keep
// the direct source-URI fallback in the app until every client loads markdown
// images through this proxy; only then remove that fallback.
export async function GET(request: NextRequest): Promise<Response> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const url = request.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    return await fetchSafeMedia(url);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Media proxy failed.' },
      { status: 400 }
    );
  }
}
