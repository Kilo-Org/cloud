'use client';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type MenuItem = {
  title: string;
  icon: React.ElementType;
  url: string;
  className?: string;
};

type SidebarMenuListProps = {
  items: MenuItem[];
  label?: string;
};

export default function SidebarMenuList({ items, label = 'Dashboard' }: SidebarMenuListProps) {
  const pathname = usePathname();

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-muted-foreground font-medium">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(item => {
            const isActive =
              pathname === item.url ||
              (pathname.startsWith(item.url + '/') &&
                !items.some(
                  other =>
                    other.url !== item.url &&
                    other.url.startsWith(item.url + '/') &&
                    (pathname === other.url || pathname.startsWith(other.url + '/')),
                ));
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild>
                  <Link
                    href={item.url}
                    prefetch={false}
                    className={`flex items-center gap-3 transition-colors ${
                      isActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''
                    } ${item.className || ''}`}
                  >
                    <item.icon className="h-4 w-4" />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
