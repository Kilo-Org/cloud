import type { NextRequest, NextResponse } from 'next/server';
import {
  deleteCustomRouterResponse,
  getCustomRouterResponse,
  handleCustomRouterRequest,
  updateCustomRouterResponse,
} from '@/lib/auto-routing-custom-routers';

type RouteContext = { params: Promise<{ scope: string; slug: string }> };

export async function GET(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const routerParams = await params;
  return handleCustomRouterRequest(request, context =>
    getCustomRouterResponse(context, routerParams)
  );
}

export async function PATCH(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const routerParams = await params;
  return handleCustomRouterRequest(request, context =>
    updateCustomRouterResponse(context, routerParams, request)
  );
}

export async function DELETE(request: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const routerParams = await params;
  return handleCustomRouterRequest(request, context =>
    deleteCustomRouterResponse(context, routerParams)
  );
}
