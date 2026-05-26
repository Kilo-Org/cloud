import type { WorkspaceSelection } from './WorkspaceSelector';

type SearchParamReader = {
  get(name: string): string | null;
};

export function getSetupStepIndex(searchParams: SearchParamReader): number {
  return searchParams.get('step') === '1' ? 1 : 0;
}

export function getSetupWorkspace(searchParams: SearchParamReader): WorkspaceSelection | null {
  const organizationId = searchParams.get('organizationId');
  if (organizationId) return { type: 'org', id: organizationId };
  if (getSetupStepIndex(searchParams) === 1) return { type: 'personal' };
  return null;
}

export function getInitialSetupState(searchParams: SearchParamReader): {
  stepIndex: number;
  workspace: WorkspaceSelection | null;
} {
  const workspace = getSetupWorkspace(searchParams);
  const requestedStepIndex = getSetupStepIndex(searchParams);

  return {
    stepIndex: requestedStepIndex === 1 && workspace === null ? 0 : requestedStepIndex,
    workspace,
  };
}

export function buildSetupPath({
  stepIndex,
  workspace,
}: {
  stepIndex: number;
  workspace: WorkspaceSelection | null;
}): string {
  const params = new URLSearchParams();

  if (stepIndex > 0) params.set('step', '1');
  if (workspace?.type === 'org') params.set('organizationId', workspace.id);

  const query = params.toString();
  return query ? `/collab?${query}` : '/collab';
}
