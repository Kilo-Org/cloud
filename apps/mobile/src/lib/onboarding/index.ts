/**
 * Barrel module for the mobile KiloClaw onboarding package.
 *
 * Leaf modules live in `./shapes.ts`, `./machine.ts`, `./selectors.ts`, and
 * `./gateway-502-grace.ts`. This file must not add any local definitions —
 * doing so risks re-introducing an import cycle with the leaf modules.
 */

export { type BotIdentity, type ExecPreset, execPresetToConfig } from './shapes';

export {
  INITIAL_STATE,
  reduce,
  type OnboardingState,
  type ProvisionErrorCategory,
} from './machine';

export {
  isProvisioningTerminal,
  shouldAdvanceFromProvisioning,
  shouldFireCompletion,
  shouldFireOnboardingEntered,
  shouldSaveBotIdentity,
  shouldSaveExecPreset,
} from './selectors';

export { checkGraceExpired } from './gateway-502-grace';
