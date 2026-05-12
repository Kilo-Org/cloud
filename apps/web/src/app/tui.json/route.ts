import { NextResponse } from "next/server";

/**
 * Serves the Kilo TUI keybind config JSON Schema at `app.kilo.ai/tui.json`.
 *
 * Fetches the upstream opencode schema at request time. Cached at the CDN edge
 * for 1 hour with stale-while-revalidate, so the actual upstream fetch happens
 * at most once per hour per region.
 *
 * The URL is referenced as `$schema` in generated `tui.json` files by the
 * Kilo CLI (`packages/opencode/src/cli/cmd/tui/config/tui-migrate.ts`) and in
 * the keybinds documentation at `https://app.kilo.ai/docs/customize/keybinds`.
 */

const UPSTREAM = "https://opencode.ai/tui.json";
const CACHE_SECONDS = 60 * 60; // 1 hour

export async function GET() {
  const res = await fetch(UPSTREAM, { next: { revalidate: CACHE_SECONDS } });
  if (!res.ok) {
    return NextResponse.json(
      { error: `upstream ${UPSTREAM} returned ${res.status}` },
      { status: 502 },
    );
  }
  const upstream: unknown = await res.json();

  return NextResponse.json(upstream, {
    headers: {
      "cache-control": `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`,
      "access-control-allow-origin": "*",
    },
  });
}
