import type { Meta, StoryObj } from '@storybook/nextjs';
import { Bot, CreditCard, Home, MoreHorizontal, Plus, Settings } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';

const meta: Meta = {
  title: 'Components/Layout/Sidebar',
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const primaryItems = [
  { icon: Home, label: 'Dashboard', active: true, badge: '4' },
  { icon: Bot, label: 'Cloud sessions', active: false, badge: '12' },
  { icon: CreditCard, label: 'Billing', active: false },
  { icon: Settings, label: 'Settings', active: false },
];

export const Expanded: Story = {
  render: () => (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md text-xs font-semibold">
              K
            </div>
            <span className="text-sm font-semibold">Kilo Cloud</span>
          </div>
          <SidebarInput placeholder="Search sessions" />
        </SidebarHeader>
        <SidebarSeparator />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupAction aria-label="Create workspace">
              <Plus />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {primaryItems.map(item => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton isActive={item.active} tooltip={item.label}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {item.badge && <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>}
                    <SidebarMenuAction showOnHover aria-label={`Open ${item.label} actions`}>
                      <MoreHorizontal />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Recent</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton size="sm">
                    <Bot />
                    <span>Storybook upgrade</span>
                  </SidebarMenuButton>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton href="#" isActive>
                        Visual QA
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton href="#">Review notes</SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg">
                <div className="bg-sidebar-accent flex size-8 items-center justify-center rounded-md text-xs font-medium">
                  JD
                </div>
                <span>Jean du Plessis</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
          <h1 className="text-sm font-medium">Sidebar preview</h1>
        </header>
        <main className="grid min-h-[520px] place-items-center p-6">
          <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
            <h2 className="text-lg font-semibold">Inset content</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              Toggle the sidebar to check expanded, collapsed, rail, menu, badge, and skeleton
              states.
            </p>
            <Button className="mt-4">Primary action</Button>
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  ),
};
