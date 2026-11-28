import {
  authorizeBenchmarkUsageReceiptsLegacy,
  handleBenchmarkUsageReceipts,
} from '@kilocode/web-shared/lib/ai-gateway/handlers/benchmark-usage-receipts';
import { authorizeInternalServiceRequest } from '@/lib/internal-api-auth';

/**
 * Frankfurt-local read of native usage receipts by `microdollar_usage.id`.
 *
 * The benchmark Worker asks whether a model request it admitted has a committed usage row.
 * Reading here, beside the PostgreSQL primary, means a row that just committed is visible;
 * `pending` means there is no row and is disclosed as such, never treated as free.
 */
export const maxDuration = 30;

async function authorize(request: Request): Promise<Response | null> {
  const auth = await authorizeInternalServiceRequest(
    request,
    'usage_receipts',
    'benchmark_usage_receipts',
    () => authorizeBenchmarkUsageReceiptsLegacy(request)
  );
  return auth instanceof Response ? auth : null;
}

export async function POST(request: Request): Promise<Response> {
  return handleBenchmarkUsageReceipts(request, authorize);
}
