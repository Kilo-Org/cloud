import { SessionRow } from '@/components/ui/session-row';

type CompactSessionRowProps = {
  agentLabel: string;
  title: string;
  meta?: string;
  isLive: boolean;
  onPress: () => void;
  last?: boolean;
};

/**
 * Thin wrapper around the shared `SessionRow` primitive for Home-screen call
 * sites. Preserves the existing module export so any external imports keep
 * working.
 */
export function CompactSessionRow({
  agentLabel,
  title,
  meta,
  isLive,
  onPress,
  last,
}: Readonly<CompactSessionRowProps>) {
  return (
    <SessionRow
      agentLabel={agentLabel}
      title={title}
      meta={meta}
      live={isLive}
      onPress={onPress}
      last={last}
    />
  );
}
