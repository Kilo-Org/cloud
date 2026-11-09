import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { NewSessionPanel } from '@/components/cloud-agent-next/NewSessionPanel';

type PageProps = {
  searchParams: Promise<{ settings?: string }>;
};

export default async function PersonalCloudPage({ searchParams }: PageProps) {
  const { settings } = await searchParams;
  const callbackPath =
    settings === undefined ? '/cloud' : `/cloud?settings=${encodeURIComponent(settings)}`;
  await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=${encodeURIComponent(callbackPath)}`
  );
  return <NewSessionPanel />;
}
