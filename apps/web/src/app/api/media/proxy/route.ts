import { createHmac } from 'node:crypto';
import { captureException } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';
import { NextResponse, type NextRequest } from 'next/server';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { MediaProxyError, fetchSafeMedia } from '@/lib/media-proxy';
import { getUserFromAuth } from '@/lib/user/server';

const MEDIA_PROXY_RATE_LIMIT_ID = 'media-proxy';

/**
 * Request header carrying the source URL. Keeping it out of the query string
 * keeps user and agent content — including credentials inside presigned links
 * — out of access logs, Sentry breadcrumbs, and any middleware logging. The
 * query carries only an opaque per-client id, which exists so a client image
 * cache keyed on the URI does not collide between two images.
 */
export const MEDIA_SOURCE_HEADER = 'x-media-source-url';

// Compatibility: old mobile clients still fetch the source URI directly. Keep
// the direct source-URI fallback in the app until every client loads markdown
// images through this proxy; only then remove that fallback.
export async function GET(request: NextRequest): Promise<Response> {
  // Bearer only. `getUserFromAuth` also accepts the NextAuth cookie, which
  // would make this GET embeddable cross-site as `<img src=…>` on a victim's
  // session. A cross-site image request cannot set request headers.
  if (!request.headers.get('authorization')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  // Fails open when the limiter itself is unavailable: a broken limiter must
  // not blank out every image in the app.
  const { rateLimited } = await checkRateLimit(MEDIA_PROXY_RATE_LIMIT_ID, {
    request,
    rateLimitKey: createHmac('sha256', NEXTAUTH_SECRET).update(user.id).digest('base64url'),
  });
  if (rateLimited) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
  }

  const url = request.headers.get(MEDIA_SOURCE_HEADER);
  if (!url) {
    return NextResponse.json({ error: `Missing ${MEDIA_SOURCE_HEADER} header` }, { status: 400 });
  }

  try {
    return await fetchSafeMedia(url);
  } catch (error) {
    if (error instanceof MediaProxyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    captureException(error);
    return NextResponse.json({ error: 'Media proxy failed.' }, { status: 502 });
  }
}
