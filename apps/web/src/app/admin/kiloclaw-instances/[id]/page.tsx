import { redirect } from 'next/navigation';

export default async function KiloclawInstanceDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/admin/kiloclaw/${id}`);
}
