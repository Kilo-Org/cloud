import { AdminAccessDenied } from '@/app/admin/components/AdminAccessDenied';

export default function UnauthorizedPage() {
  return (
    <AdminAccessDenied message="You do not have administrative privileges to access this page." />
  );
}
