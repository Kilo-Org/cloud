import { logger } from '../logger.js';

type ClassifyResult = {
  verdict: string;
  risk_score: number;
  signals: string[];
  context: { identity_key: string; requests_per_second: number };
  request_id: number;
};

// Non-blocking abuse classification call — fail-open with 2s timeout
export async function classifyAbuse(
  _request: Request,
  _body: unknown,
  _context: {
    kiloUserId: string;
    organizationId: string | undefined;
    projectId: string | null;
    provider: string;
    isByok: boolean;
  }
): Promise<ClassifyResult | null> {
  // TODO: Port abuse service HTTP call from Next.js
  // For now, fail open (return null) so the request proceeds
  logger.debug('Abuse classification not yet implemented in worker');
  return null;
}
