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
      {/* Bottom padding clears the fixed terminal bar (title bar height = 40px) */}
      <div className="pb-12">{children}</div>
      <MayorTerminalBar params={params} />
    </>
  );
}
