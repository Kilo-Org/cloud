/**
 * Shared KiloClaw onboarding shape builders and types.
 *
 * The shape of the config patches MUST stay in sync with the controller's
 * config-writer (`services/kiloclaw/controller/...`).
 *
 * This is a leaf module: it has no imports from elsewhere in this folder.
 * `./machine.ts` depends on it for `BotIdentity` / `ExecPreset` / `OnboardingStep`;
 * keeping this module leaf prevents the barrel `./index.ts` from forming an
 * import cycle.
 */

export type ExecPreset = 'always-ask' | 'never-ask';

export type BotIdentity = {
  botName: string;
  botNature: string;
  botVibe: string;
  botEmoji: string;
};

export type OnboardingStep = 'identity' | 'channels' | 'provisioning' | 'done';

export function execPresetToConfig(preset: ExecPreset): { security: string; ask: string } {
  if (preset === 'never-ask') {
    return { security: 'full', ask: 'off' };
  }
  return { security: 'allowlist', ask: 'on-miss' };
}
