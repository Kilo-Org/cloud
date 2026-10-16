import type { NextRequest, NextResponse } from 'next/server';
import {
  handleCustomRouterRequest,
  registerClientEntryResponse,
  removeClientEntryResponse,
} from '@/lib/auto-routing-custom-routers';

type RouteContext = { params: Promise<{ scope: string; slug: string }> };

export async function POST(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const routerParams = await params;
  return handleCustomRouterRequest(request, context =>
    registerClientEntryResponse(context, routerParams, request)
  );
}

export async function DELETE(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const routerParams = await params;
  return handleCustomRouterRequest(request, context =>
    removeClientEntryResponse(context, routerParams, request)
  );
}
