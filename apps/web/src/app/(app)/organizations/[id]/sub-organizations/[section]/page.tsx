import { notFound } from 'next/navigation';

import { SubOrganizationsPage } from '../SubOrganizationsPage';
import { isSubOrganizationSection } from '../sections';

export default async function OrganizationSubOrganizationSectionPage({
  params,
}: {
  params: Promise<{ id: string; section: string }>;
}) {
  const { id, section } = await params;
  if (!isSubOrganizationSection(section)) notFound();

  return <SubOrganizationsPage organizationId={id} activeSection={section} />;
}
