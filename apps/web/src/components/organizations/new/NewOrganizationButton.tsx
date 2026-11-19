import { LinkButton } from '@/components/Button';

export function NewOrganizationButton() {
  return (
    <LinkButton variant="primary" size="lg" href="/organizations/new">
      Create Organization
    </LinkButton>
  );
}
