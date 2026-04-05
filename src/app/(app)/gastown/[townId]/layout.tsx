import { TerminalBarProvider } from '@/components/gastown/TerminalBarContext';
import { DrawerStackProvider } from '@/components/gastown/DrawerStack';
import { renderDrawerContent } from '@/components/gastown/DrawerStackContent';
import { TerminalBarPadding } from '@/components/gastown/TerminalBarPadding';
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
        <TerminalBarPadding>{children}</TerminalBarPadding>
        <MayorTerminalBar params={params} />
        <OnboardingTooltipsWrapper params={params} />
      </DrawerStackProvider>
    </TerminalBarProvider>
  );
}
