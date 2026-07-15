import { describe, expect, it } from 'vitest';

import { type LocalSessionConfigViewModel } from '@/lib/hooks/local-runtime-catalog-types';
import { buildLocalSessionConfigViewModel } from '@/lib/hooks/local-runtime-catalog-view-model';
import { type LocalSessionConfigController } from '@/lib/hooks/use-local-session-config-controller';
import { INITIAL_LOCAL_SESSION_CONFIG_SELECTION } from '@/lib/hooks/local-session-config-selection';

type ForbiddenScreenKeys =
  | 'onSubmit'
  | 'onSendPrompt'
  | 'onAddAttachment'
  | 'onCreateSession'
  | 'requestId'
  | 'readiness';

type AssertControllerHasNoForbiddenKeys = ForbiddenScreenKeys &
  keyof LocalSessionConfigController extends never
  ? true
  : false;
type AssertViewModelHasNoForbiddenKeys = ForbiddenScreenKeys &
  keyof LocalSessionConfigViewModel extends never
  ? true
  : false;

const _controllerAssertion: AssertControllerHasNoForbiddenKeys = true;
const _viewModelAssertion: AssertViewModelHasNoForbiddenKeys = true;
void _controllerAssertion;
void _viewModelAssertion;

const minimalController: LocalSessionConfigController = {
  selection: INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
  runtimesState: { data: undefined, isError: false, refetch: () => undefined },
  catalogState: { kind: 'idle' },
  onSelectFence: () => undefined,
  onClearFence: () => undefined,
  onSelectAgent: () => undefined,
  onSelectModel: () => undefined,
  onResetOverrides: () => undefined,
};

const baseViewModel = buildLocalSessionConfigViewModel({
  runtimesState: minimalController.runtimesState,
  selectedFence: minimalController.selection.selectedFence,
  onSelectFence: minimalController.onSelectFence,
  onClearFence: minimalController.onClearFence,
  catalogState: minimalController.catalogState,
});

describe('LocalSessionConfigScreen catalog-only contract', () => {
  it('controller exposes only selection, state, and picker handlers', () => {
    const keys = Object.keys(minimalController) as (keyof LocalSessionConfigController)[];
    expect(keys).not.toContain('onSubmit');
    expect(keys).not.toContain('onSendPrompt');
    expect(keys).not.toContain('onAddAttachment');
    expect(keys).not.toContain('onCreateSession');
  });

  it('view-model is a screen-state discriminated union without submission fields', () => {
    const keys = Object.keys(baseViewModel) as (keyof LocalSessionConfigViewModel)[];
    expect(keys).not.toContain('requestId');
    expect(keys).not.toContain('readiness');
    expect(keys).not.toContain('onSubmit');
    expect(keys).not.toContain('onCreateSession');
  });
});
