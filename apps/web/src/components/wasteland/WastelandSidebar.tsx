'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
} from '@/components/ui/sidebar';
import {
  ArrowLeft,
  ScrollText,
  ClipboardCheck,
  Users,
  Settings,
  Skull,
  Truck,
  Inbox,
} from 'lucide-react';
import { motion } from 'motion/react';

type WastelandSidebarProps = {
  wastelandId: string;
  /** Override the base path for org-scoped routes (e.g. /organizations/[id]/wasteland/[wastelandId]) */
  basePath?: string;
  /** Link target for the "All wastelands" back button */
  backHref?: string;
} & React.ComponentProps<typeof Sidebar>;

export function WastelandSidebar({
  wastelandId,
  basePath: basePathOverride,
  backHref = '/wasteland',
  ...sidebarProps
}: WastelandSidebarProps) {
  const pathname = usePathname();

  const basePath = basePathOverride ?? `/wasteland/${wastelandId}`;

  const isActive = (path: string) => {
    if (path === `${basePath}/wanted`) {
      // Wanted is also active for the bare wasteland path (which redirects to wanted)
      return pathname === basePath || pathname.startsWith(`${basePath}/wanted`);
    }
    return pathname.startsWith(path);
  };

  const navItems = [
    { title: 'Wanted Board', icon: ScrollText, url: `${basePath}/wanted` },
    { title: 'Claims', icon: ClipboardCheck, url: `${basePath}/claims` },
    { title: 'Members', icon: Users, url: `${basePath}/members` },
    // Review (admin inbox for open upstream PRs) sits before Rigs — admins
    // typically spend more time triaging PRs than managing the rig registry.
    { title: 'Review', icon: Inbox, url: `${basePath}/review` },
    { title: 'Rigs', icon: Truck, url: `${basePath}/rigs` },
  ];

  return (
    <Sidebar {...sidebarProps}>
      <SidebarHeader className="p-3">
        <div className="flex flex-col gap-3">
          {/* Back link */}
          <Link
            href={backHref}
            prefetch={false}
            className="group/back inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-white/45 transition-colors hover:bg-white/5 hover:text-white/75"
          >
            <ArrowLeft className="size-3 transition-transform group-hover/back:-translate-x-0.5" />
            All wastelands
          </Link>

          {/* Wasteland identity */}
          <div className="flex items-center gap-2.5 px-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[color:oklch(70%_0.15_30_/_0.15)] ring-1 ring-[color:oklch(70%_0.15_30_/_0.25)]">
              <Skull className="size-4 text-[color:oklch(70%_0.15_30)]" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white/90">Wasteland</div>
              <div className="flex items-center gap-1.5 text-[10px] text-white/40">
                <span className="size-1.5 rounded-full bg-amber-400" />
                Active
              </div>
            </div>
          </div>
        </div>
      </SidebarHeader>

      <div className="mx-3 border-b border-white/[0.08]" />

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] font-semibold tracking-[0.08em] text-white/30 uppercase">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item, i) => (
                <motion.div
                  key={item.title}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.2 }}
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={isActive(item.url)}>
                      <Link href={item.url} prefetch={false}>
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </motion.div>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive(`${basePath}/settings`)}>
              <Link href={`${basePath}/settings`} prefetch={false}>
                <Settings className="size-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
