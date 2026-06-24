import { cva } from 'class-variance-authority';

export const cardClassName = 'bg-card text-card-foreground rounded-xl border border-border';
export const cardHeaderClassName = 'flex flex-col gap-1.5 p-6 pb-2';
export const cardTitleClassName = 'type-heading';
export const cardDescriptionClassName = 'type-body text-muted-foreground';
export const cardContentClassName = 'p-6 pt-0';
export const cardFooterClassName = 'flex items-center p-6 pt-0';

export const inputClassName =
  'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input bg-input-background font-sans text-base leading-6 md:text-sm md:leading-[1.5] flex h-control-default w-full min-w-0 rounded-md border px-3 py-1 transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/40 aria-invalid:border-destructive';

export const textareaClassName =
  'border-input bg-input-background type-body placeholder:text-muted-foreground flex min-h-20 w-full rounded-md border px-3 py-2 transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/40 aria-invalid:border-destructive';

export const popoverContentClassName =
  'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-[--radix-popover-content-transform-origin] rounded-lg border border-border p-3 shadow-none outline-none';

export const hoverCardContentClassName =
  'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-[--radix-hover-card-content-transform-origin] rounded-lg border border-border p-3 shadow-none outline-none';

export const dialogOverlayClassName =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-surface-inset/80 duration-200';
export const dialogContentClassName =
  'bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98 fixed top-[50%] left-[50%] z-50 grid w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-border p-6 shadow-none duration-200';
export const dialogCloseClassName =
  'focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-3 right-3 flex size-control-default cursor-pointer items-center justify-center rounded-md opacity-70 transition-opacity hover:bg-accent hover:opacity-100 focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none';
export const dialogTitleClassName = 'type-heading';
export const dialogDescriptionClassName = 'type-body text-muted-foreground';

export const sheetOverlayClassName =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-surface-inset/70';
export const sheetDismissibleOverlayClassName =
  'absolute inset-0 z-50 cursor-default bg-surface-inset/70';
export const sheetContentClassName =
  'bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 border-border shadow-none transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500';
export const sheetCloseClassName =
  'focus-visible:ring-ring/50 data-[state=open]:bg-accent absolute top-4 right-4 flex size-control-default items-center justify-center rounded-md opacity-70 transition-opacity hover:bg-accent hover:opacity-100 focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none';
export const sheetHeaderClassName = 'flex flex-col gap-1.5 p-6 pb-2';
export const sheetFooterClassName = 'mt-auto flex flex-col gap-2 p-6 pt-2';
export const sheetTitleClassName = 'type-heading text-foreground';
export const sheetDescriptionClassName = 'type-body text-muted-foreground';

export const tableClassName = 'type-body w-full caption-bottom';
export const tableHeaderClassName = 'border-b border-border';
export const tableBodyClassName = '[&_tr:last-child]:border-0';
export const tableFooterClassName = 'bg-surface-raised border-t border-border font-medium';
export const tableRowClassName =
  'h-12 border-b border-border transition-colors hover:bg-surface-hover data-[state=selected]:bg-surface-selected';
export const tableHeadClassName =
  'type-label text-muted-foreground h-12 px-3 text-left align-middle whitespace-nowrap';
export const tableCellClassName = 'px-3 py-3 align-middle';
export const tableCaptionClassName = 'type-body text-muted-foreground mt-4';

export const sidebarMenuSubButtonClassName =
  'text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-surface-selected active:text-sidebar-accent-foreground [&>svg]:text-sidebar-accent-foreground flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 outline-hidden focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 data-[active=true]:bg-surface-selected data-[active=true]:text-sidebar-accent-foreground';

export const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-surface-selected active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-surface-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline:
          'border border-sidebar-border bg-sidebar hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);
