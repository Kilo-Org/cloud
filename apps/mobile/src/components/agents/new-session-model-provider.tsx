import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type AgentMode } from '@/components/agents/mode-selector';
import { resolvePrefillModel } from '@/components/agents/new-session-prefill';
import { useNewSessionPrefill } from '@/components/agents/use-new-session-prefill';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useAutoSelectModel } from '@/lib/hooks/use-auto-select-model';

export type NewSessionModelState = {
  mode: AgentMode;
  setMode: Dispatch<SetStateAction<AgentMode>>;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  variant: string;
  setVariant: Dispatch<SetStateAction<string>>;
  /**
   * The organization-default read's failure while nothing is selected yet. It
   * is the only remaining input that could have chosen the model, so the form
   * states it and offers the read again instead of committing a fallback row.
   */
  modelSelectionFailure: { onRetry: () => void; isRetrying: boolean } | null;
};

type NewSessionModelProviderProps = {
  organizationId: string | undefined;
  children: ReactNode;
};

const NewSessionModelContext = createContext<NewSessionModelState | null>(null);

export function useNewSessionModelState(): NewSessionModelState {
  const state = useContext(NewSessionModelContext);
  if (state === null) {
    throw new Error('useNewSessionModelState must be used within NewSessionModelProvider');
  }
  return state;
}

export function NewSessionModelProvider({
  organizationId,
  children,
}: Readonly<NewSessionModelProviderProps>) {
  const prefill = useNewSessionPrefill();
  const [mode, setMode] = useState<AgentMode>(prefill.mode);
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const { models } = useAvailableModels(organizationId);
  const autoSelected = useAutoSelectModel(models, organizationId);
  // The selection is resolved from the account the form shows: the catalog, the
  // route prefill and the auto-selection all read this one scope, so the model
  // and variant the form holds belong to the account the session is created in.
  // `null` is the personal account, so it never shares a key with an
  // organization.
  const scope = organizationId ?? null;
  const resolvedScope = useRef<{ scope: string | null } | null>(null);
  if (resolvedScope.current?.scope !== scope) {
    resolvedScope.current = { scope };
    if (model !== '' || variant !== '') {
      setModel('');
      setVariant('');
    }
  }
  const initialSelection =
    resolvePrefillModel(models, prefill) ??
    (autoSelected.kind === 'selected'
      ? { model: autoSelected.model, variant: autoSelected.variant }
      : null);
  if (initialSelection?.model && !model) {
    setModel(initialSelection.model);
    setVariant(initialSelection.variant);
  }
  // The hook's retry is the query's own stable callback, so the failure object
  // keeps one identity across renders and the context value does not churn; it
  // clears the moment a model is committed.
  const orgDefaultRetry = autoSelected.kind === 'org-default-failed' ? autoSelected.onRetry : null;
  const orgDefaultRetrying =
    autoSelected.kind === 'org-default-failed' ? autoSelected.isRetrying : false;
  const modelSelectionFailure = useMemo(() => {
    if (model !== '' || orgDefaultRetry === null) {
      return null;
    }
    return { onRetry: orgDefaultRetry, isRetrying: orgDefaultRetrying };
  }, [model, orgDefaultRetry, orgDefaultRetrying]);
  const state = useMemo(
    () => ({ mode, setMode, model, setModel, variant, setVariant, modelSelectionFailure }),
    [mode, model, variant, modelSelectionFailure]
  );

  return (
    <NewSessionModelContext.Provider value={state}>{children}</NewSessionModelContext.Provider>
  );
}
