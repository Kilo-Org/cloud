export const API_KIND_LABELS = {
  chat_completions: 'Chat Completions',
  responses: 'Responses',
  messages: 'Anthropic Messages',
} as const;

export type ApiKind = keyof typeof API_KIND_LABELS;

export function isApiKind(value: string): value is ApiKind {
  return Object.hasOwn(API_KIND_LABELS, value);
}

export function apiKindLabel(value: string): string {
  return isApiKind(value) ? API_KIND_LABELS[value] : value;
}
