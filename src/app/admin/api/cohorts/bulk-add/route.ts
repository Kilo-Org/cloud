import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@/lib/user.server';
import { bulkAddCohort, type BulkAddCohortResponse } from '@/lib/cohorts/bulkAddCohort';

const schema = z.object({
  user_identifiers: z.array(z.string().min(1)).min(1),
  cohort_name: z.string().min(1),
});

export async function POST(
  request: NextRequest
): Promise<NextResponse<BulkAddCohortResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      {
        success: false,
        error: `Validation error: ${parsed.error.issues.map(i => i.message).join(', ')}`,
      },
      { status: 400 }
    );

  const { user_identifiers, cohort_name } = parsed.data;
  const result = await bulkAddCohort(user_identifiers, cohort_name);
  const status = result.success ? 200 : 400;
  return NextResponse.json(result, { status });
}
