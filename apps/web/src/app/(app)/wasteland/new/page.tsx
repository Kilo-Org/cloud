import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { NewWastelandWizardClient } from './NewWastelandWizardClient';

export default async function NewWastelandPage() {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/wasteland/new');

  return <NewWastelandWizardClient />;
}
