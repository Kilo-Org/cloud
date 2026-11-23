import { type Href } from 'expo-router';

/**
 * The route name the list settings sheet registers under in the `(app)` Stack.
 * Creating a list replaces the sheet with the new list, and the list names the
 * sheet to remove the covered form (`retire-covered-source.ts`).
 */
export const TODO_LIST_SETTINGS_ROUTE_NAME = 'todos/list-settings';

/**
 * The route directly beneath the list settings sheet when the Agents tab's
 * list view opens it: the tabs navigator is a single route of the `(app)`
 * Stack, so the create hand-off's guard beneath the form is `(tabs)`.
 */
export const TODO_AGENTS_TAB_ROUTE_NAME = '(tabs)';

export function todoListPath(listId: string): Href {
  return `/(app)/todos/${encodeURIComponent(listId)}` as Href;
}

export function todoItemPath(itemId: string): Href {
  return `/(app)/todos/item/${encodeURIComponent(itemId)}` as Href;
}

/** The list settings sheet: edits `listId`, or creates a list in `organizationId`'s context. */
export function todoListSettingsPath(input: {
  listId?: string;
  organizationId: string | null;
  /**
   * What creating a list does next: the default opens the created list, while
   * `'back'` returns to the sheet that pushed this one (the "Save as to-do" list
   * picker, which still holds the draft the caller came to save).
   */
  afterCreate?: 'back';
}): Href {
  const entries: [string, string][] = [];
  if (input.listId) {
    entries.push(['listId', input.listId]);
  }
  if (input.organizationId) {
    entries.push(['organizationId', input.organizationId]);
  }
  if (input.afterCreate) {
    entries.push(['afterCreate', input.afterCreate]);
  }
  const query = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `/(app)/todos/list-settings${query ? `?${query}` : ''}` as Href;
}
