import { NextResponse } from 'next/server';
import { buildImpactUttScript } from '@/lib/marketing-tag-scripts';

export function GET() {
  if (!process.env.NEXT_PUBLIC_IMPACT_UTT_ID) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(buildImpactUttScript(process.env.NEXT_PUBLIC_IMPACT_UTT_ID), {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
