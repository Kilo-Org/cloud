import { TerminalBarProvider } from '@/components/gastown/TerminalBarContext';
import { DrawerStackProvider } from '@/components/gastown/DrawerStack';
import { renderDrawerContent } from '@/components/gastown/DrawerStackContent';
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
        {/* Fullscreen edge-to-edge layout for gastown town pages.
            Bottom padding clears the fixed terminal bar. */}
        <div className="flex min-h-screen flex-col pb-[340px]">
          <div className="flex-1">{children}</div>
        </div>
        <MayorTerminalBar params={params} basePath={basePath} />
      </DrawerStackProvider>
    </TerminalBarProvider>
  );
}
