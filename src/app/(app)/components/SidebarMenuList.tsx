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
  allUrls?: string[];
};

export default function SidebarMenuList({
  items,
  label = 'Dashboard',
  allUrls,
}: SidebarMenuListProps) {
  const pathname = usePathname();
  const urlsToCheck = allUrls ?? items.map(i => i.url);

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-muted-foreground font-medium">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(item => {
            const matchesPrefix = pathname === item.url || pathname.startsWith(item.url + '/');
            const hasMoreSpecificMatch =
              matchesPrefix &&
              urlsToCheck.some(
                url =>
                  url !== item.url &&
                  url.length > item.url.length &&
                  (pathname === url || pathname.startsWith(url + '/'))
              );
            const isActive = matchesPrefix && !hasMoreSpecificMatch;
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
