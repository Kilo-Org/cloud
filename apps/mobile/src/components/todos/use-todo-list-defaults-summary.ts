import { useTranslation } from 'react-i18next';

import { getBuiltinModeLabelKey } from '@/components/agents/mode-options';
import { modelLabelFromCatalogue } from '@/lib/auto-model-name';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { type TodoList } from '@/lib/todos/todo-types';

/** `repo · mode · model` for the list header, or null when the list sets no defaults. */
export function useTodoListDefaultsSummary(
  list: Pick<TodoList, 'organizationId' | 'gitUrl' | 'mode' | 'model'> | undefined
): string | null {
  const { t } = useTranslation();
  const { models } = useAvailableModels(list?.organizationId ?? undefined);
  if (!list) {
    return null;
  }
  const parts: string[] = [];
  if (list.gitUrl) {
    parts.push(list.gitUrl);
  }
  if (list.mode) {
    const modeKey = getBuiltinModeLabelKey(list.mode);
    parts.push(modeKey ? t(modeKey) : list.mode);
  }
  if (list.model) {
    parts.push(modelLabelFromCatalogue(models, list.model));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
