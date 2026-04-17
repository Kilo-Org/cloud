import { NextResponse } from 'next/server';
import { kiloExtras } from './extras';

/**
 * Serves the Kilo CLI config JSON Schema at `app.kilo.ai/config.json`.
 *
 * Fetches the upstream opencode schema at request time and overlays Kilo's
 * additions/overrides (see `./extras.ts`). Cached at the CDN edge for 1 hour
 * with stale-while-revalidate, so the actual upstream fetch happens at most
 * once per hour per region.
 */

const UPSTREAM = 'https://opencode.ai/config.json';
const CACHE_SECONDS = 60 * 60; // 1 hour

export type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function merge(schema: Schema): Schema {
  const properties = isObject(schema.properties) ? { ...schema.properties } : {};
  Object.assign(properties, kiloExtras.top);

  const agent = isObject(properties.agent) ? { ...properties.agent } : {};
  agent.properties = {
    ...(isObject(agent.properties) ? agent.properties : {}),
    ...kiloExtras.agents,
  };
  properties.agent = agent;

  const experimental = isObject(properties.experimental) ? { ...properties.experimental } : {};
  experimental.properties = {
    ...(isObject(experimental.properties) ? experimental.properties : {}),
    ...kiloExtras.experimental,
  };
  properties.experimental = experimental;

  return { ...schema, properties };
}

export async function GET() {
  const res = await fetch(UPSTREAM, { next: { revalidate: CACHE_SECONDS } });
  if (!res.ok) {
    return NextResponse.json(
      { error: `upstream ${UPSTREAM} returned ${res.status}` },
      { status: 502 }
    );
  }
  const upstream = (await res.json()) as Schema;
  const merged = merge(upstream);

  return NextResponse.json(merged, {
    headers: {
      'cache-control': `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  });
}
