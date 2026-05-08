'use client';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type MenuItem = {
  title: string;
  icon: React.ElementType;
  url?: string;
  onClick?: () => void;
  isActive?: boolean;
  suffixIcon?: React.ElementType;
  subtitle?: string;
  badge?: string;
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
                {item.subtitle ? (
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate">{item.title}</span>
                    <span className="text-muted-foreground truncate text-xs font-normal">
                      {item.subtitle}
                    </span>
                  </span>
                ) : (
                  <span>{item.title}</span>
                )}
                {item.suffixIcon && <item.suffixIcon className="ml-auto h-4 w-4" />}
              </>
            );
            const buttonClassName = cn(
              'flex items-center gap-3 transition-colors',
              item.subtitle && 'h-12 py-2',
              item.badge && 'pr-14',
              item.className
            );

            return (
              <SidebarMenuItem key={item.title}>
                {item.url ? (
                  <SidebarMenuButton
                    asChild
                    isActive={isActive}
                    size={item.subtitle ? 'lg' : 'default'}
                  >
                    <Link href={item.url} prefetch={false} className={buttonClassName}>
                      {content}
                    </Link>
                  </SidebarMenuButton>
                ) : (
                  <SidebarMenuButton
                    type="button"
                    onClick={item.onClick}
                    isActive={isActive}
                    size={item.subtitle ? 'lg' : 'default'}
                    className={cn('cursor-pointer', buttonClassName)}
                  >
                    {content}
                  </SidebarMenuButton>
                )}
                {item.badge && (
                  <SidebarMenuBadge className="bg-brand-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground right-4 !top-1/2 h-4 min-w-0 !-translate-y-1/2 rounded-full px-1.5 text-[10px] font-bold tracking-wide uppercase ring-1 ring-brand-primary/30">
                    {item.badge}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
