import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu wording corrections. Each entry below disagreed with its English
 * source or with the same catalog's own siblings:
 *
 * - `profiles.slashCommands.title` was an imperative clause ("slash the
 *   commands") where the screen header names the feature, and the block's own
 *   `add` and `empty` rows already read `స్లాష్ ఆదేశాలు`.
 * - `profiles.slashCommands.template` said `మూస` while the inline required
 *   error on the same sheet said `టెంప్లేట్`, so one field carried two terms.
 * - `profiles.slashCommands.deleteFailed` and `profiles.variablesDeleteFailed`
 *   borrowed the English loan verb `డిలీట్` where `profiles.deleteFailed`, the
 *   delete buttons and the confirm titles all use `తొలగించు`.
 * - `securityAgent.analysis.analyzed` was a finished-event clause ("analysis
 *   completed"), but the key is shared by the finding status chip and the
 *   analysis panel title, so it has to be a bare participle that names the
 *   finding's state and can sit next to `notRecorded`.
 * - `securityAgent.analysis.exploitabilityReasoning` used `దుర్వినియోగ`
 *   (misuse) for a finding whose `exploitable` status reads `దాడికి
 *   వాడుకోదగినది` (usable for attack).
 *
 * The values are pinned so a later edit cannot reintroduce the same wording.
 */

type Case = { key: string; value: string };

const CASES: Case[] = [
  {
    key: 'securityAgent.analysis.analyzed',
    value: 'విశ్లేషించినది',
  },
  {
    key: 'securityAgent.analysis.exploitabilityReasoning',
    value: 'దాడికి వాడుకోదగినదా అనే అంచనాకు ఆధారం',
  },
  {
    key: 'profiles.slashCommands.title',
    value: 'స్లాష్ ఆదేశాలు',
  },
  {
    key: 'profiles.slashCommands.template',
    value: 'ఆదేశ టెంప్లేట్',
  },
  {
    key: 'profiles.slashCommands.deleteFailed',
    value: 'ఆదేశాన్ని తొలగించడం సాధ్యపడలేదు',
  },
  {
    key: 'profiles.slashCommands.templateRequired',
    value: 'ఆదేశ టెంప్లేట్‌ను నమోదు చేయండి',
  },
  {
    key: 'profiles.variablesDeleteFailed',
    value: 'వేరియబుల్‌ను తొలగించడం సాధ్యపడలేదు',
  },
];

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu slash-command, variable and Security Agent analysis copy', () => {
  it.each(CASES)('reads $value at $key', async ({ key, value }) => {
    await i18n.changeLanguage('te');
    expect(i18n.t(key)).toBe(value);
  });
});
