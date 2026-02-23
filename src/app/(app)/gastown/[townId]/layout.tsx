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
      {/* Bottom padding clears the fixed terminal bar (40px title + 320px terminal) */}
      <div className="pb-[360px]">{children}</div>
      <MayorTerminalBar params={params} />
    </>
  );
}
