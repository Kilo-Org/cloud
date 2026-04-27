import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { NewWastelandWizardClient } from './NewWastelandWizardClient';

export default async function NewWastelandPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/wasteland/new');

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <NewWastelandWizardClient />;
}
