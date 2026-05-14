import { NextResponse } from 'next/server';
import { buildGoogleTagManagerScript } from '@/lib/marketing-tag-scripts';

export function GET() {
  if (!process.env.NEXT_PUBLIC_GTM_ID) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(buildGoogleTagManagerScript(process.env.NEXT_PUBLIC_GTM_ID), {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
