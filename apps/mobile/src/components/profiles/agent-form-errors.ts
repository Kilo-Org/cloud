import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  type AgentFormError,
} from '@/components/profiles/profile-agents-model';

/** Catalog key for each refused field, so the message lands under the input at fault. */
const ERROR_KEYS = {
  'slug-required': 'profiles.agents.slugRequired',
  'slug-invalid': 'profiles.agents.slugInvalid',
  'slug-conflict': 'profiles.agents.slugConflict',
  'name-required': 'profiles.agents.nameRequired',
  'name-too-long': 'profiles.tooLong',
  'description-too-long': 'profiles.tooLong',
} satisfies Record<AgentFormError, string>;

type Translate = (key: string, options?: { max: number }) => string;

/**
 * The localized message for a refused field. A length refusal names the
 * server's bound, so the reader can shorten the value to fit.
 */
export function agentErrorText(t: Translate, error: AgentFormError): string {
  if (error === 'name-too-long') {
    return t(ERROR_KEYS[error], { max: AGENT_NAME_MAX_LENGTH });
  }
  if (error === 'description-too-long') {
    return t(ERROR_KEYS[error], { max: AGENT_DESCRIPTION_MAX_LENGTH });
  }
  return t(ERROR_KEYS[error]);
}

/** The slug field's message: its own refusal, or a conflict the server reported. */
export function slugFieldError(
  t: Translate,
  error: AgentFormError | null,
  serverConflict: boolean
): string | undefined {
  if (error === 'slug-required' || error === 'slug-invalid' || error === 'slug-conflict') {
    return agentErrorText(t, error);
  }
  return error === null && serverConflict ? agentErrorText(t, 'slug-conflict') : undefined;
}
