import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useTranslation } from 'react-i18next';
import { type AccessibilityProps, Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { joinAccessibleName } from '@/lib/a11y/accessible-name';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatNumber, formatPrefixedMoney } from '@/lib/format';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useOrgUsageStats } from '@/lib/hooks/use-organization-queries';

/**
 * One stat card. The value slot keeps its height when the number resolves —
 * the `stat` variant's `text-lg` measures 24.8 dp and the loading block is
 * 24 dp — so the label under it cannot move when the query answers.
 *
 * `asElement` says who names the tile. `true`: the card is one accessibility
 * element that reads caption then value, and its two painted lines leave both
 * trees (Android maps `accessible={false}` onto focusability alone, hence
 * `HIDDEN_LABEL_PROPS`). `false`: the enclosing button that opens the usage
 * screen already names this tile in the grid's order, so no platform may reach
 * the tile separately — the card carries no name and the lines stay hidden.
 * A loading tile contributes its caption alone.
 */
function StatTile({
  label,
  value,
  asElement,
}: Readonly<{ label: string; value: string | null; asElement: boolean }>) {
  const tileProps = asElement
    ? ({
        accessible: true,
        accessibilityRole: 'text',
        accessibilityLabel: joinAccessibleName([label, value ?? undefined]),
      } satisfies AccessibilityProps)
    : {};
  return (
    <Card className="flex-1" {...tileProps}>
      {value === null ? (
        // `bg-muted-soft`, not the default `bg-skeleton-fill`: in light mode the
        // placeholder fill equals the card's own `bg-secondary`, so a default
        // skeleton paints nothing. The hub's low-balance subtitle reserves its
        // line the same way.
        <Skeleton className="h-7 w-16 rounded-md bg-muted-soft" />
      ) : (
        <Text variant="stat" {...HIDDEN_LABEL_PROPS}>
          {value}
        </Text>
      )}
      <Text variant="caption" {...HIDDEN_LABEL_PROPS}>
        {label}
      </Text>
    </Card>
  );
}

type OrgUsageStatsProps = {
  organizationId: string;
  /**
   * Turns the section into the entry point for the full usage screen, for a
   * role that screen answers organization-wide. Absent leaves the numbers
   * informational.
   */
  onPress?: () => void;
};

/**
 * "All members · last 30 days" eyebrow + 2x2 usage stat tile grid.
 * Visible to all org roles.
 *
 * The eyebrow names every member because the tiles are organization-wide
 * totals. The grid is the entry point to the usage screen only for a role that
 * screen answers organization-wide; every other role reaches its own usage
 * through the hub's usage destination row, which names that scope
 * (`usage.orgSelfEntryTitle`), so the grid stays informational there rather
 * than opening a screen whose numbers would not match the tiles.
 *
 * The grid carries no entrance animation: it is the section's entire body, so a
 * fade that does not run leaves four cards unpainted while their frames and
 * accessibility nodes are already in place.
 *
 * With `onPress` the grid alone opens the usage screen, inside the section
 * rather than around it: the eyebrow names the scope on both platforms, and the
 * grid is one button announced in grid order whose tiles are not elements of
 * their own. The section cannot load keeps its own retry row instead of the
 * wrapper: a pressable around a retry button leaves the reader guessing which
 * control a tap reaches.
 *
 * The two token tiles print the same input and output totals the usage screen
 * prints, so they use its compact notation and the two screens can be compared
 * at a glance.
 *
 * The informational grid is four accessibility elements in grid order (cost,
 * requests, input tokens, output tokens), each read caption then value. The
 * pressable grid is one button announced in that same grid order, and its
 * tiles are not elements of their own: a reader moving by element must reach
 * the grid once, not a text stop per tile followed by the control that opens
 * the screen.
 *
 * The pressable grid also carries a visible destination in the section header —
 * the usage screen's own title (`usage.title`), painted in the section action —
 * because the grid's hint is announced to a screen reader and invisible to a
 * sighted member, who would otherwise see four read-only-looking cards. The
 * action ends in the chevron the hub's other destinations carry, so the header
 * reads as one more way out of the screen. It is the screen's title rather than
 * "view details" because that copy rendered 145 dp wide and pushed a 360 dp
 * compact header onto two lines, away from the eyebrow it belongs to. The
 * header action is painted only in the pressable state, so the informational
 * grid keeps the header and the geometry it has.
 */
export function OrgUsageStats({ organizationId, onPress }: Readonly<OrgUsageStatsProps>) {
  const { t } = useTranslation();
  const { data, isError, isFetching, refetch } = useOrgUsageStats(organizationId);
  // The read settles offline too (`SETTLE_WHILE_OFFLINE`), so `isPaused` can
  // no longer name the connection; the committed connectivity state does, the
  // same source the offline banner paints.
  const committedConnectivity = useCommittedConnectivityStatus();
  const unavailable = data == null && (isError || committedConnectivity === 'offline');
  // One condition decides both surfaces of the destination: the section
  // header's link and the pressable wrapper around the grid.
  const opensUsage = onPress !== undefined && !unavailable;
  // A tile with no totals yet shows a loading block while the first request is
  // outstanding, the dash when the section cannot load at all, and the cached
  // totals through a refetch error.
  const missingValue = unavailable ? '—' : null;

  // The four tiles in grid order. The painted grid and the button that opens
  // the usage screen both read from this one list, so the spoken order and the
  // printed order cannot drift apart.
  const tiles = [
    {
      label: t('common.cost'),
      // A money amount's symbol is neutral to the paragraph's direction, so the
      // run keeps its own left-to-right order inside the tile.
      value: data
        ? isolateLtrBidiText(formatPrefixedMoney(fromMicrodollars(data.totalCost), i18n.language))
        : missingValue,
    },
    {
      label: t('organization.usageStats.requests'),
      value: data ? formatNumber(data.totalRequestCount, i18n.language) : missingValue,
    },
    {
      label: t('organization.usageStats.inputTokens'),
      value: data
        ? formatNumber(data.totalInputTokens, i18n.language, {
            notation: 'compact',
            maximumFractionDigits: 1,
          })
        : missingValue,
    },
    {
      label: t('organization.usageStats.outputTokens'),
      value: data
        ? formatNumber(data.totalOutputTokens, i18n.language, {
            notation: 'compact',
            maximumFractionDigits: 1,
          })
        : missingValue,
    },
  ] as const;
  // Only the pressable grid needs this name: the informational grid's four
  // tiles each name themselves. The section eyebrow already names the scope
  // (every member, the last 30 days) beside the grid, so the button names the
  // totals alone — neither stop repeats the other.
  const gridLabel = joinAccessibleName(tiles.flatMap(tile => [tile.label, tile.value]));

  const grid = (
    <View className="gap-3">
      {[tiles.slice(0, 2), tiles.slice(2, 4)].map(row => (
        <View key={row[0]?.label} className="flex-row gap-3">
          {row.map(tile => (
            <StatTile
              key={tile.label}
              label={tile.label}
              value={tile.value}
              asElement={!opensUsage}
            />
          ))}
        </View>
      ))}
    </View>
  );

  return (
    <Section
      label={t('organization.usageStats.orgLast30Days')}
      actionLabel={opensUsage ? t('usage.title') : undefined}
      actionChevron
      onActionPress={onPress}
      actionTestID={opensUsage ? 'org-usage-action' : undefined}
    >
      {opensUsage ? (
        // The button wraps the grid, not the section: the eyebrow stays its own
        // heading stop beside it on both platforms.
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={gridLabel}
          accessibilityHint={t('usage.viewDetails')}
          className="active:opacity-70"
        >
          {grid}
        </Pressable>
      ) : (
        grid
      )}
      {unavailable && (
        <View className="gap-2">
          <Text accessibilityRole="alert" variant="muted">
            {t(
              committedConnectivity === 'offline'
                ? 'queryError.offlineTitle'
                : 'common.somethingWentWrong'
            )}
          </Text>
          <Button variant="outline" loading={isFetching} onPress={() => void refetch()}>
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      )}
    </Section>
  );
}
