import { NextResponse } from 'next/server';
import { withBlockedClients } from '@/middleware/withBlockedClients';

export const proxy = withBlockedClients(() => NextResponse.next());

export const config = {
  matcher: ['/api/v1/fim/completions'],
};
