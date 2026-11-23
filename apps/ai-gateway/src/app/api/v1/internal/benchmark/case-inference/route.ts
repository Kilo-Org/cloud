import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { handleBenchmarkCaseInference } from '@kilocode/web-shared/lib/ai-gateway/handlers/benchmark-case-inference';

// Internal: the auto-routing benchmark Worker's just-in-time payer boundary. The Worker signs
// one assignment per model request; this route authenticates it and delegates to the normal
// LLM proxy so the case is billed by native usage under the signed payer.
export const POST = withRestTiming(
  '/api/v1/internal/benchmark/case-inference',
  (request: Request) => handleBenchmarkCaseInference(request)
);

export const maxDuration = 800;
