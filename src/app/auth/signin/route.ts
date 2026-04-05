import { APP_URL } from '@/lib/constants';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse<unknown>> {
  const searchParams = request.nextUrl.searchParams;
  const source = searchParams.get('source');
  const redirectUrl = `${APP_URL}/profile${source ? `?source=${source}` : ''}`;
  return NextResponse.redirect(redirectUrl);
}
