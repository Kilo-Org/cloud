import type { Meta, StoryObj } from '@storybook/nextjs';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppShellSkipLink } from '@/components/AppShellSkipLink';
import AdminPage from '@/app/admin/components/AdminPage';
import { AppSidebarView } from '@/app/admin/components/AppSidebar';

const meta: Meta = {
  title: 'Components/Layout/App Shell',
  parameters: {
    layout: 'fullscreen',
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: '/admin/users',
        query: {},
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function AdminUsersPreview() {
  return (
    <div className="w-full rounded-xl border border-border bg-card">
      <div className="border-b border-border px-6 py-4">
        <h2 className="type-heading">Users</h2>
        <p className="type-body text-muted-foreground mt-1">
          Admin page content begins below the canonical 56px topbar.
        </p>
      </div>
      <div className="grid grid-cols-[1.2fr_1fr_0.8fr] border-b border-border px-6 py-3 type-label text-muted-foreground">
        <span>User</span>
        <span>Status</span>
        <span>Credits</span>
      </div>
      {[
        ['Jean du Plessis', 'Active', '$142.20'],
        ['Avery Stone', 'Trial', '$18.00'],
        ['Morgan Lee', 'Blocked', '$0.00'],
      ].map(row => (
        <div
          key={row[0]}
          className="grid grid-cols-[1.2fr_1fr_0.8fr] items-center border-b border-border/70 px-6 py-3 type-body last:border-b-0"
        >
          <span className="font-medium">{row[0]}</span>
          <span className="text-muted-foreground">{row[1]}</span>
          <span className="font-mono tabular-nums">{row[2]}</span>
        </div>
      ))}
    </div>
  );
}

function AdminShellPreview() {
  return (
    <SidebarProvider defaultOpen>
      <AppShellSkipLink />
      <div className="flex min-h-screen">
        <AppSidebarView
          variant="inset"
          pathname="/admin/users"
          session={null}
          pendingDisputesCount={3}
        >
          <div className="type-label text-muted-foreground">Build preview</div>
        </AppSidebarView>
        <SidebarInset>
          <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
            <AdminPage
              breadcrumbs={
                <BreadcrumbItem>
                  <BreadcrumbPage>Users</BreadcrumbPage>
                </BreadcrumbItem>
              }
              buttons={<Button variant="outline">Export users</Button>}
            >
              <AdminUsersPreview />
            </AdminPage>
          </main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}

export const AdminShell: Story = {
  render: () => <AdminShellPreview />,
};

export const SkipLinkFocused: Story = {
  render: () => <AdminShellPreview />,
  play: async () => {
    document.querySelector<HTMLAnchorElement>('a[href="#main-content"]')?.focus();
  },
};
