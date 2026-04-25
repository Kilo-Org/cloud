import { connection, NextResponse } from 'next/server';
import { MODELS_BY_PROVIDER_ADMIN_URL } from '@kilocode/db/schema';
import { redisGet } from '@/lib/redis';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';

export async function GET() {
  await connection();

  const raw = await redisGet(GATEWAY_METADATA_REDIS_KEYS.allProviders);
  if (raw === null) {
    throw new Error(
      'No models data found in Redis. Use the admin panel at ' + MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  return NextResponse.json(JSON.parse(raw), {
    headers: {
      'Cache-Control': `max-age=0, s-maxage=60`,
    },
  });
}
