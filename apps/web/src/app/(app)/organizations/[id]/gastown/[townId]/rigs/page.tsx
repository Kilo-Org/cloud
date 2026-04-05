import { redirect } from 'next/navigation';

// Rigs are listed in the town overview — redirect there.
export default async function OrgRigsPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { id, townId } = await params;
  redirect(`/organizations/${id}/gastown/${townId}`);
}
