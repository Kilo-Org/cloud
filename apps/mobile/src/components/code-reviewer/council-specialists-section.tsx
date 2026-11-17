import {
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_SPECIALIST_PRESETS,
} from '@kilocode/app-shared/code-review';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ToggleRow } from '@/components/security-agent/settings-toggle-row';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type CouncilConfig } from '@/lib/code-reviewer-config';
import { specialistCopy, wouldStarveCouncil } from '@/lib/code-reviewer-council';
import { formatNumber } from '@/lib/format';
import { enabledSpecialistCount } from '@/lib/hooks/use-reviewer-council';

/**
 * The council's specialist switches, one per preset, plus the guard that keeps
 * an enabled council at or above its voting minimum.
 *
 * The web form refuses the equivalent save; a per-toggle screen has to refuse
 * the toggle itself, or it stores a council that is switched on and below the
 * voting minimum, which never runs.
 */
export function CouncilSpecialistsSection({
  council,
  disabled,
  onWrite,
}: Readonly<{
  council: CouncilConfig;
  disabled: boolean;
  onWrite: (next: CouncilConfig) => void;
}>) {
  const { t } = useTranslation();

  const setSpecialistEnabled = (id: string, value: boolean) => {
    if (wouldStarveCouncil(council, id, value)) {
      announcingToast.error(
        t('codeReviewer.council.minSpecialists', {
          minimum: formatNumber(COUNCIL_MIN_SPECIALISTS, i18n.language),
          selected: formatNumber(enabledSpecialistCount(council) - 1, i18n.language),
        })
      );
      return;
    }
    if (council.specialists.some(specialist => specialist.id === id)) {
      onWrite({
        ...council,
        specialists: council.specialists.map(specialist =>
          specialist.id === id ? { ...specialist, enabled: value } : specialist
        ),
      });
      return;
    }
    const preset = COUNCIL_SPECIALIST_PRESETS.find(candidate => candidate.id === id);
    if (!preset) {
      return;
    }
    onWrite({
      ...council,
      specialists: [
        ...council.specialists,
        {
          id: preset.id,
          role: preset.role,
          name: preset.name,
          enabled: value,
          required: false,
          lens: preset.lens,
        },
      ],
    });
  };

  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('codeReviewer.council.specialists')}
      </Text>
      {COUNCIL_SPECIALIST_PRESETS.map(preset => {
        const copy = specialistCopy(preset.id);
        return (
          <ToggleRow
            key={preset.id}
            title={t(copy.nameKey)}
            subtitle={t(copy.descriptionKey)}
            value={council.specialists.some(
              specialist => specialist.id === preset.id && specialist.enabled
            )}
            disabled={disabled}
            onValueChange={value => {
              setSpecialistEnabled(preset.id, value);
            }}
          />
        );
      })}
    </View>
  );
}
