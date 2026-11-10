import {
  AutoRouterSchema,
  PlatformMeasurementsResponseSchema,
} from '@kilocode/auto-routing-contracts';
import { NextResponse, type NextRequest } from 'next/server';
import {
  CustomRouterApiError,
  handleCustomRouterRequest,
  platformMeasurements,
} from '@/lib/auto-routing-custom-routers';

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleCustomRouterRequest(request, async () => {
    const router = AutoRouterSchema.safeParse(request.nextUrl.searchParams.get('router'));
    if (!router.success) {
      throw new CustomRouterApiError('invalid_request', 'router must be efficient or frontier');
    }
    const measurements = await platformMeasurements(router.data);
    return NextResponse.json(PlatformMeasurementsResponseSchema.parse(measurements));
  });
}
