/**
 * The copy one draft problem renders, in the language the app is showing.
 *
 * The map is exhaustive over `TriggerProblem`, so a new rule cannot reach the
 * form without copy; the form looks a problem up by its own value.
 */

import { i18n } from '@/i18n';

import { type TriggerProblem } from './trigger-draft';

const PROBLEM_KEYS = {
  required: 'cloudAgent.triggers.problems.nameRequired',
  tooShort: 'cloudAgent.triggers.problems.nameTooShort',
  tooLong: 'cloudAgent.triggers.problems.nameTooLong',
  characters: 'cloudAgent.triggers.problems.nameCharacters',
  reserved: 'cloudAgent.triggers.problems.nameReserved',
  cronRequired: 'cloudAgent.triggers.problems.cronRequired',
  repositoryRequired: 'cloudAgent.triggers.problems.repositoryRequired',
  agentRequired: 'cloudAgent.triggers.problems.agentRequired',
  agentInvalid: 'cloudAgent.triggers.problems.agentInvalid',
  modelRequired: 'cloudAgent.triggers.problems.modelRequired',
  promptRequired: 'cloudAgent.triggers.problems.promptRequired',
  bodySchemaInvalid: 'cloudAgent.triggers.problems.bodySchemaInvalid',
  authHeaderRequired: 'cloudAgent.triggers.problems.authHeaderRequired',
  authSecretRequired: 'cloudAgent.triggers.problems.authSecretRequired',
  authSecretTooShort: 'cloudAgent.triggers.problems.authSecretTooShort',
} satisfies Record<TriggerProblem, string>;

export function triggerProblemMessage(problem: TriggerProblem): string {
  return i18n.t(PROBLEM_KEYS[problem]);
}
