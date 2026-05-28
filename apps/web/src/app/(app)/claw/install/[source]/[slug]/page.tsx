import { notFound } from 'next/navigation';
import { fetchInstallPayload } from '@/lib/kiloclaw/install';
import { INSTALL_SOURCES, isInstallSource } from '@/lib/kiloclaw/install-sources';
import { InstallClient } from './InstallClient';

type InstallPageProps = {
  params: Promise<{ source: string; slug: string }>;
};

export default async function InstallPage({ params }: InstallPageProps) {
  const { source, slug } = await params;

  if (!isInstallSource(source)) notFound();

  const payload = await fetchInstallPayload(source, slug);
  if (!payload) notFound();

  return (
    <InstallClient source={source} sourceLabel={INSTALL_SOURCES[source].label} payload={payload} />
  );
}
