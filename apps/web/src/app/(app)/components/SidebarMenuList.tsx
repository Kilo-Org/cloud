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
  url?: string;
  onClick?: () => void;
  isActive?: boolean;
  suffixIcon?: React.ElementType;
  className?: string;
};

type SidebarMenuListProps = {
  items: MenuItem[];
  label?: string | null;
  allUrls?: string[];
};

export default function SidebarMenuList({
  items,
  label = 'Dashboard',
  allUrls,
}: SidebarMenuListProps) {
  const pathname = usePathname();
  const urlsToCheck = allUrls ?? items.flatMap(i => (i.url ? [i.url] : []));

  return (
    <SidebarGroup>
      {label && (
        <SidebarGroupLabel className="text-muted-foreground font-medium">{label}</SidebarGroupLabel>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(item => {
            const itemUrl = item.url;
            const matchesPrefix = itemUrl
              ? pathname === itemUrl || pathname.startsWith(itemUrl + '/')
              : false;
            const hasMoreSpecificMatch =
              matchesPrefix &&
              itemUrl &&
              urlsToCheck.some(
                url =>
                  url !== itemUrl &&
                  url.length > itemUrl.length &&
                  (pathname === url || pathname.startsWith(url + '/'))
              );
            const isActive = item.isActive ?? (matchesPrefix && !hasMoreSpecificMatch);
            const content = (
              <>
                <item.icon className="h-4 w-4" />
                <span>{item.title}</span>
                {item.suffixIcon && <item.suffixIcon className="ml-auto h-4 w-4" />}
              </>
            );

            return (
              <SidebarMenuItem key={item.title}>
                {item.url ? (
                  <SidebarMenuButton asChild isActive={isActive}>
                    <Link
                      href={item.url}
                      prefetch={false}
                      className={`flex items-center gap-3 transition-colors ${item.className || ''}`}
                    >
                      {content}
                    </Link>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    type="button"
                    onClick={item.onClick}
                    isActive={isActive}
                    className={`flex cursor-pointer items-center gap-3 transition-colors ${item.className || ''}`}
                  >
                    {content}
                  </SidebarMenuButton>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
