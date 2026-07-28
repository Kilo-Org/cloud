import { TerminalBarProvider } from '@/components/gastown/TerminalBarContext';
import { DrawerStackProvider } from '@/components/gastown/DrawerStack';
import { renderDrawerContent } from '@/components/gastown/DrawerStackContent';
import { TerminalBarPadding } from '@/components/gastown/TerminalBarPadding';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import { GASTOWN_BILLING_ANNOUNCEMENT_ENABLED } from '@/lib/config.server';
import { MayorTerminalBar } from './MayorTerminalBar';
import { OnboardingTooltipsWrapper } from './OnboardingTooltipsWrapper';

export default function TownLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ townId: string }>;
}) {
  return (
    <TerminalBarProvider>
      <DrawerStackProvider renderContent={renderDrawerContent}>
        <HideAppTopbar />
        <TerminalBarPadding>{children}</TerminalBarPadding>
        <MayorTerminalBar
          params={params}
          billingAnnouncementEnabled={GASTOWN_BILLING_ANNOUNCEMENT_ENABLED}
        />
        <OnboardingTooltipsWrapper params={params} />
      </DrawerStackProvider>
    </TerminalBarProvider>
  );
}
