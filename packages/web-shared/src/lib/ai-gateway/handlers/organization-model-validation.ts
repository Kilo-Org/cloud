import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { parseModelValidationRequest } from './model-validation-request';
import { handleTRPCRequest } from '@kilocode/web-shared/lib/organizations/organization-settings-route-handler';

type ValidationResult = { valid: true } | { valid: false; reason: 'unavailable' };

export async function handleOrganizationModelValidationRequest(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ error: string; message?: string } | ValidationResult>> {
  const bodyResult = await parseModelValidationRequest(request);
  if (!bodyResult.success) {
    return bodyResult.response;
  }

  const organizationId = (await params).id;
  return handleTRPCRequest<ValidationResult>(request, async caller => {
    const result = await caller.organizations.settings.listAvailableModels({ organizationId });
    const available = result.data.some(model => model.id === bodyResult.data.modelId);
    return available ? { valid: true } : { valid: false, reason: 'unavailable' };
  });
}
