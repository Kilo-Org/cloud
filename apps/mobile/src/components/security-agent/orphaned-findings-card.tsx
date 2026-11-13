import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useConfirmDialog } from '@/components/ui/dialog';
import { ShieldAlert } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { LINE_ACTION_BOX_CLASS, LINE_ACTION_HIT_SLOP } from '@/lib/a11y/tap-target';
import { formatNumber } from '@/lib/format';
import {
  useDeleteFindingsByRepository,
  useOrphanedRepositories,
} from '@/lib/hooks/use-security-orphaned-findings';
import { i18n } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * Findings that belong to repositories the integration no longer exposes
 * (the web config page's ClearFindingsCard). They stay countable in dashboards
 * and reports until they are deleted, so the card names each repository with
 * what deleting it removes, and asks once before doing so.
 *
 * Nothing renders while the read is loading, failed or empty: a destructive
 * control is not something to offer on a guess, and the list only appears when
 * there is orphaned data to act on.
 */
export function OrphanedFindingsCard({
  scope,
  canManage,
}: Readonly<{ scope: string; canManage: boolean }>) {
  const { t } = useTranslation();
  const orphans = useOrphanedRepositories(scope);
  const removeFindings = useDeleteFindingsByRepository(scope);
  const { confirm, dialog } = useConfirmDialog();
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);

  if (!orphans.data || orphans.data.length === 0) {
    return null;
  }

  return (
    <>
      <View className="mt-4 gap-2 rounded-lg bg-warn-tile-bg p-4">
        <View className="flex-row items-center gap-2">
          <ShieldAlert size={16} className="text-foreground" />
          <Text className="flex-1 text-sm font-medium">
            {t('securityAgent.orphanedFindings.title')}
          </Text>
        </View>
        <Text variant="muted" className="text-xs">
          {t('securityAgent.orphanedFindings.description')}
        </Text>
        {orphans.data.map(repository => {
          const busy = pendingRepo === repository.repoFullName && removeFindings.isPending;
          return (
            <View
              key={repository.repoFullName}
              className="flex-row items-center gap-3 border-t border-hair-soft pt-2"
            >
              <View className="min-w-0 flex-1 py-1">
                <Text className="text-sm" numberOfLines={1}>
                  {repository.repoFullName}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs">
                  {t('securityAgent.orphanedFindings.count', {
                    count: formatNumber(repository.findingCount, i18n.language),
                  })}
                </Text>
              </View>
              <Pressable
                className={cn(
                  LINE_ACTION_BOX_CLASS,
                  'justify-center px-2 active:opacity-70',
                  (!canManage || busy) && 'opacity-60'
                )}
                hitSlop={LINE_ACTION_HIT_SLOP}
                disabled={!canManage || busy}
                accessibilityRole="button"
                accessibilityLabel={t('securityAgent.orphanedFindings.clearLabel', {
                  repository: repository.repoFullName,
                })}
                accessibilityState={{ disabled: !canManage || busy }}
                onPress={() => {
                  setPendingRepo(repository.repoFullName);
                  confirm({
                    title: t('securityAgent.orphanedFindings.confirmTitle'),
                    message: t('securityAgent.orphanedFindings.confirmMessage', {
                      repository: repository.repoFullName,
                    }),
                    confirmLabel: t('securityAgent.orphanedFindings.confirmAction'),
                    onConfirm: () => {
                      removeFindings.mutate(repository.repoFullName);
                    },
                  });
                }}
              >
                <Text variant="muted" className="text-xs underline">
                  {t('prReview.floatingActions.clear')}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      {dialog}
    </>
  );
}
