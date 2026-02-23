import { MayorTerminalBar } from './MayorTerminalBar';

export default function TownLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ townId: string }>;
}) {
  return (
    <>
      {/* Page content with bottom padding to clear the fixed terminal bar */}
      <div className="pb-[360px]">{children}</div>
      <MayorTerminalBar params={params} />
    </>
  );
}
