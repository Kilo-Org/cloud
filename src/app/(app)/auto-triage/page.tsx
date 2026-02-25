import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { AutoTriagePageClient } from './AutoTriagePageClient';

type AutoTriagePageProps = {
  searchParams: Promise<{ success?: string; error?: string }>;
};

export default async function PersonalAutoTriagePage({ searchParams }: AutoTriagePageProps) {
  const search = await searchParams;
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/auto-triage');

  return (
    <AutoTriagePageClient
      userId={user.id}
      userName={user.google_user_name}
      successMessage={search.success}
      errorMessage={search.error}
    />
  );
}
