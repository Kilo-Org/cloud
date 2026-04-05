import { AppBuilderPage } from '@/components/app-builder/AppBuilderPage';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';

type Props = {
  params: Promise<{ projectId: string }>;
};

export default async function ProjectPage({ params }: Props) {
  const { projectId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/app-builder/${projectId}`);

  return <AppBuilderPage organizationId={undefined} projectId={projectId} />;
}
