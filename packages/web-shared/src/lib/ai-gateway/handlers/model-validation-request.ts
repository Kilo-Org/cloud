import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';

const ModelValidationRequestSchema = z.object({ modelId: z.string().trim().min(1) });

export type ModelValidationRequest = z.infer<typeof ModelValidationRequestSchema>;

type ModelValidationRequestErrorBody = {
  error: string;
  details?: ReturnType<typeof z.treeifyError<ModelValidationRequest>>;
};

export type ParsedModelValidationRequest =
  | { success: true; data: ModelValidationRequest }
  | { success: false; response: NextResponse<ModelValidationRequestErrorBody> };

export async function parseModelValidationRequest(
  request: NextRequest
): Promise<ParsedModelValidationRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }

  const result = ModelValidationRequestSchema.safeParse(body);
  if (!result.success) {
    return {
      success: false,
      response: NextResponse.json(
        { error: 'Invalid request body', details: z.treeifyError(result.error) },
        { status: 400 }
      ),
    };
  }

  return { success: true, data: result.data };
}
