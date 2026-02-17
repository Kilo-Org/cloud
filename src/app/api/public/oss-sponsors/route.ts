import { db, sql } from '@/lib/drizzle';
import { organizations } from '@/db/schema';
import { NextResponse } from 'next/server';
import { and, isNull } from 'drizzle-orm';

type OssSponsor = {
  githubUrl: string;
  tier: number;
};

export async function GET(): Promise<NextResponse<OssSponsor[]>> {
  const ossOrgs = await db
    .select({
      settings: organizations.settings,
    })
    .from(organizations)
    .where(
      and(
        sql`${organizations.settings}->>'oss_sponsorship_tier' IS NOT NULL`,
        sql`${organizations.settings}->>'oss_github_url' IS NOT NULL`,
        isNull(organizations.deleted_at)
      )
    );

  const sponsors: OssSponsor[] = [];
  for (const org of ossOrgs) {
    const tier = org.settings.oss_sponsorship_tier;
    const githubUrl = org.settings.oss_github_url;
    if (tier != null && githubUrl) {
      sponsors.push({ githubUrl, tier });
    }
  }

  return NextResponse.json(sponsors, {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/** Handle CORS preflight requests. */
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
