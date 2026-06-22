import 'server-only';
import { NextResponse } from 'next/server';
import { nativeMcpProtectedResourceMetadata } from '@kilocode/mcp-gateway';
import { APP_URL } from '@/lib/constants';

export async function GET() {
  const appBaseUrl = process.env.MCP_GATEWAY_APP_BASE_URL || APP_URL;
  return NextResponse.json(nativeMcpProtectedResourceMetadata(appBaseUrl), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
