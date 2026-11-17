import { type SessionShareDuration } from '@kilocode/session-ingest-contracts';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

import {
  DURATION_LABEL_KEYS,
  ShareActiveLink,
  type ShareDistribution,
} from './session-share-active-link';
import { type SharePanel } from './session-share-state';

/** The share durations the worker accepts, in the order the row shows them. */
const SHARE_DURATIONS: readonly SessionShareDuration[] = ['1h', '1d', '7d', '30d', 'forever'];

/** The choice a link is created with: how long it lives, and whether later messages join it. */
type ShareChoice = Readonly<{
  duration: SessionShareDuration;
  includeNewMessages: boolean;
  handleDurationChange: (duration: SessionShareDuration) => void;
  handleIncludeNewMessagesChange: (includeNewMessages: boolean) => void;
}>;

/**
 * The configuration a link is created with: its duration and whether later
 * messages join the share. It is shown in the create, existing-link and
 * superseded states, because replacing an existing link uses exactly this
 * choice — hiding it there would replace the link with the defaults instead of
 * what the person picked.
 */
function ShareConfiguration({ choice, busy }: Readonly<{ choice: ShareChoice; busy: boolean }>) {
  const { t } = useTranslation();
  const durationLabels = SHARE_DURATIONS.map(value => ({
    value,
    label: t(DURATION_LABEL_KEYS[value]),
  }));
  return (
    <View className="gap-3">
      <View className="gap-2">
        <Text className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('sessionShare.durationLabel')}
        </Text>
        <SegmentedControl
          options={durationLabels}
          value={choice.duration}
          onChange={choice.handleDurationChange}
          accessibilityLabel={t('sessionShare.durationLabel')}
        />
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-sm font-medium text-foreground">
            {t('sessionShare.includeNewMessages')}
          </Text>
          <Text variant="muted" className="text-xs">
            {choice.includeNewMessages
              ? t('sessionShare.includeNewMessagesOn')
              : t('sessionShare.includeNewMessagesOff')}
          </Text>
        </View>
        <Switch
          testID="session-share-include-new"
          accessibilityLabel={t('sessionShare.includeNewMessages')}
          value={choice.includeNewMessages}
          disabled={busy}
          onValueChange={choice.handleIncludeNewMessagesChange}
        />
      </View>
    </View>
  );
}

type ReplacementProps = Readonly<{
  choice: ShareChoice;
  busy: boolean;
  creating: boolean;
  revoking: boolean;
  /**
   * Whether this panel needs a note naming what the settings configure. The
   * existing-link panel already says so in its description; the superseded
   * panel says only that the link is gone, so the note belongs there.
   */
  scopeNote?: boolean;
  onCreate: () => void;
  onRevoke: () => void;
}>;

/**
 * Replacing the live link: the configuration it is created with, the create
 * action that rotates it, and revoke for the link that exists now. When the
 * panel passes `scopeNote`, the note sits inside the configuration's own group,
 * so it reads as that block's caption instead of as another paragraph.
 */
function ReplacementActions({
  choice,
  busy,
  creating,
  revoking,
  scopeNote = false,
  onCreate,
  onRevoke,
}: ReplacementProps) {
  const { t } = useTranslation();
  const configuration = <ShareConfiguration choice={choice} busy={busy} />;
  return (
    <>
      {scopeNote ? (
        <View className="gap-2">
          <Text variant="muted" className="text-xs">
            {t('sessionShare.replacementSettings')}
          </Text>
          {configuration}
        </View>
      ) : (
        configuration
      )}
      <Button
        variant="outline"
        className="w-full"
        loading={creating}
        disabled={busy}
        onPress={onCreate}
        testID="session-share-rotate"
      >
        {t('sessionShare.rotate')}
      </Button>
      <Button
        variant="outline-destructive"
        className="w-full"
        loading={revoking}
        disabled={busy}
        onPress={onRevoke}
        testID="session-share-revoke"
      >
        {t('sessionShare.revoke')}
      </Button>
    </>
  );
}

type CreateProps = Readonly<{
  choice: ShareChoice;
  busy: boolean;
  creating: boolean;
  onCreate: () => void;
}>;

function NoLinkPanel({ choice, busy, creating, onCreate }: CreateProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <ShareConfiguration choice={choice} busy={busy} />
      <Button
        className="w-full"
        loading={creating}
        disabled={busy}
        onPress={onCreate}
        testID="session-share-create"
      >
        {t('sessionShare.create')}
      </Button>
    </View>
  );
}

/*
 * The state names that a link exists, not that it works: `cli_sessions_v2`
 * stores only `public_id`, and a share token's expiry never reaches the client,
 * so an expired link is indistinguishable from a live one here. Replacing it
 * uses the configuration above instead of silent defaults.
 */
function ExistingLinkPanel(props: ReplacementProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <Text className="text-sm font-medium text-foreground" testID="session-share-existing">
        {t('sessionShare.existingTitle')}
      </Text>
      <Text variant="muted" className="text-xs">
        {t('sessionShare.existingDescription')}
      </Text>
      <ReplacementActions {...props} />
    </View>
  );
}

/*
 * This sheet's URL is no longer the live one. Offering Copy or Share would hand
 * out a link that no longer works, so the panel says that and offers a fresh
 * link — and Revoke, which ends the link that is live now and says so in its own
 * confirmation.
 */
function SupersededPanel(props: ReplacementProps) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <Text variant="muted" className="text-xs" testID="session-share-superseded">
        {t('sessionShare.superseded')}
      </Text>
      <ReplacementActions {...props} scopeNote />
    </View>
  );
}

/*
 * The session row could not be read, so this sheet cannot tell whether a link
 * exists or whether the one it made is still live. Offer the read again instead
 * of an action that would silently rotate a link another device may hold.
 */
function ReadFailedPanel({
  retrying,
  onRetry,
}: Readonly<{ retrying: boolean; onRetry: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <Text className="text-xs text-destructive" testID="session-share-state-error">
        {t('common.somethingWentWrong')}
      </Text>
      <Button
        variant="outline"
        className="w-full"
        loading={retrying}
        onPress={onRetry}
        testID="session-share-state-retry"
      >
        {t('common.retry')}
      </Button>
    </View>
  );
}

/**
 * The body of the sheet for one panel state: the live link this sheet made, a
 * link that was replaced elsewhere, a read that failed, the reading line, the
 * link that already exists, or the create form. Each state draws only the
 * actions its facts can vouch for.
 */
export function SharePanelBody({
  panel,
  duration,
  includeNewMessages,
  onDurationChange,
  onIncludeNewMessagesChange,
  busy,
  creating,
  revoking,
  distribution,
  retrying,
  onCopy,
  onShare,
  onCreate,
  onRetry,
  onRevoke,
}: Readonly<{
  panel: SharePanel;
  duration: SessionShareDuration;
  includeNewMessages: boolean;
  onDurationChange: (duration: SessionShareDuration) => void;
  onIncludeNewMessagesChange: (includeNewMessages: boolean) => void;
  busy: boolean;
  creating: boolean;
  revoking: boolean;
  distribution: ShareDistribution | null;
  retrying: boolean;
  onCopy: () => void;
  onShare: () => void;
  onCreate: () => void;
  onRetry: () => void;
  onRevoke: () => void;
}>) {
  const { t } = useTranslation();
  if (panel.kind === 'linkCreated') {
    return (
      <ShareActiveLink
        url={panel.url}
        lifetime={duration}
        includeNewMessages={includeNewMessages}
        copyState={panel.copy}
        busy={busy}
        revoking={revoking}
        distribution={distribution}
        onCopy={onCopy}
        onShare={onShare}
        onRevoke={onRevoke}
      />
    );
  }
  const choice: ShareChoice = {
    duration,
    includeNewMessages,
    handleDurationChange: onDurationChange,
    handleIncludeNewMessagesChange: onIncludeNewMessagesChange,
  };
  if (panel.kind === 'linkSuperseded') {
    return (
      <SupersededPanel
        choice={choice}
        busy={busy}
        creating={creating}
        revoking={revoking}
        onCreate={onCreate}
        onRevoke={onRevoke}
      />
    );
  }
  if (panel.kind === 'readFailed') {
    return <ReadFailedPanel retrying={retrying} onRetry={onRetry} />;
  }
  if (panel.kind === 'reading') {
    return (
      <Text variant="muted" className="text-xs" testID="session-share-state-loading">
        {t('common.loading')}
      </Text>
    );
  }
  if (panel.kind === 'linkElsewhere') {
    return (
      <ExistingLinkPanel
        choice={choice}
        busy={busy}
        creating={creating}
        revoking={revoking}
        onCreate={onCreate}
        onRevoke={onRevoke}
      />
    );
  }
  return <NoLinkPanel choice={choice} busy={busy} creating={creating} onCreate={onCreate} />;
}
