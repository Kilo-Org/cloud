import { NextResponse } from 'next/server';

/**
 * Serves the Kilo CLI TUI config JSON Schema at `app.kilo.ai/tui.json`.
 *
 * Proxies the upstream opencode schema. Cached at the CDN edge for 1 hour
 * with stale-while-revalidate, so the actual upstream fetch happens at most
 * once per hour per region.
 */

const UPSTREAM = 'https://opencode.ai/tui.json';
const CACHE_SECONDS = 60 * 60; // 1 hour

export async function GET() {
  const res = await fetch(UPSTREAM, { next: { revalidate: CACHE_SECONDS } });
  if (!res.ok) {
    return NextResponse.json(
      { error: `upstream ${UPSTREAM} returned ${res.status}` },
      { status: 502 }
    );
  }
  const schema = await res.json();

  return NextResponse.json(schema, {
    headers: {
      'cache-control': `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  });
}
