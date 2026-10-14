import { handleBenchmarkBillingRequest } from '../_handler';

export async function POST(request: Request) {
  return handleBenchmarkBillingRequest(request, 'settle');
}
