import { readDb } from '@/lib/drizzle';
import { app_min_versions } from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const row = await readDb
      .select({
        ios: app_min_versions.ios_min_version,
        android: app_min_versions.android_min_version,
      })
      .from(app_min_versions)
      .limit(1);

    if (row.length === 0) {
      return NextResponse.json({ error: 'No min version configured' }, { status: 500 });
    }

    return NextResponse.json(row[0], {
      headers: { 'Cache-Control': 'public, max-age=300' },
    });
  } catch (error) {
    captureException(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
