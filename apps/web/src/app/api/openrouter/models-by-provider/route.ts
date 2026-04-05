import { connection, NextResponse } from 'next/server';
import { MODELS_BY_PROVIDER_ADMIN_URL, modelsByProvider } from '@kilocode/db/schema';
import { desc } from 'drizzle-orm';
import { db } from '@/lib/drizzle';

export async function GET() {
  await connection();

  const result = await db
    .select()
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);

  if (!result || result.length === 0) {
    throw new Error(
      'No models data found in database. Use the admin panel at ' + MODELS_BY_PROVIDER_ADMIN_URL
    );
  }

  return NextResponse.json(result[0].data, {
    headers: {
      'Cache-Control': `max-age=0, s-maxage=60`,
    },
  });
}
