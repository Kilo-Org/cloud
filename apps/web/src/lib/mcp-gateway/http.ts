import 'server-only';
import { NextResponse } from 'next/server';
import { GatewayError } from '@kilocode/mcp-gateway';
import { extractBearerToken as extractBearerTokenFromHeader } from '@kilocode/worker-utils/extract-bearer-token';

export function gatewayErrorResponse(error: unknown) {
  if (error instanceof GatewayError) {
    return NextResponse.json(
      { error: error.code, error_description: error.message },
      { status: error.status }
    );
  }
  return NextResponse.json(
    { error: 'server_error', error_description: 'Gateway request failed' },
    { status: 500 }
  );
}

export function extractBearerToken(headers: Headers): string | null {
  return extractBearerTokenFromHeader(headers.get('authorization'));
}
