import type { NextRequest, NextResponse } from 'next/server';
import {
  createCustomRouterResponse,
  handleCustomRouterRequest,
  listCustomRoutersResponse,
} from '@/lib/auto-routing-custom-routers';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleCustomRouterRequest(request, listCustomRoutersResponse);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleCustomRouterRequest(request, context =>
    createCustomRouterResponse(context, request)
  );
}
