import { APP_URL } from '@/lib/constants';
import { browserLandingPath } from '@/lib/app-link-safe-redirect';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse<unknown>> {
  const searchParams = request.nextUrl.searchParams;
  const source = searchParams.get('source');
  const path = `/profile${source ? `?source=${source}` : ''}`;
  return NextResponse.redirect(new URL(browserLandingPath(path), APP_URL));
}
