import { TerminalBarProvider } from '@/components/gastown/TerminalBarContext';
import { DrawerStackProvider } from '@/components/gastown/DrawerStack';
import { renderDrawerContent } from '@/components/gastown/DrawerStackContent';
import { TerminalBarPadding } from '@/components/gastown/TerminalBarPadding';
import { MayorTerminalBar } from '@/app/(app)/gastown/[townId]/MayorTerminalBar';

export default async function OrgTownLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; townId: string }>;
}) {
  const { id, townId } = await params;
  const basePath = `/organizations/${id}/gastown/${townId}`;

  return (
    <TerminalBarProvider>
      <DrawerStackProvider renderContent={renderDrawerContent}>
        <TerminalBarPadding>{children}</TerminalBarPadding>
        <MayorTerminalBar params={params} basePath={basePath} />
      </DrawerStackProvider>
    </TerminalBarProvider>
  );
}
