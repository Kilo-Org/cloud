import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buttonVariants } from '@/components/ui/button-variants';
import { badgeVariants } from '@/components/ui/badge-variants';
import {
  cardClassName,
  cardDescriptionClassName,
  cardTitleClassName,
  dialogContentClassName,
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogTitleClassName,
  hoverCardContentClassName,
  inputClassName,
  popoverContentClassName,
  sidebarMenuButtonVariants,
  sidebarMenuSubButtonClassName,
  sheetContentClassName,
  sheetDescriptionClassName,
  sheetDismissibleOverlayClassName,
  sheetOverlayClassName,
  sheetTitleClassName,
  tableCellClassName,
  tableHeadClassName,
  tableRowClassName,
  textareaClassName,
} from '@/components/ui/primitive-classnames';

const expectClasses = (className: string, expectedClasses: string[]) => {
  for (const expectedClass of expectedClasses) {
    expect(className).toContain(expectedClass);
  }
};

describe('design primitive defaults', () => {
  it('uses semantic global border fallback', () => {
    const globalsCss = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

    expect(globalsCss).toContain('border-color: var(--border);');
    expect(globalsCss).not.toContain('var(--color-gray-200');
  });

  it('keeps cards on raised surface without default shadow depth', () => {
    expectClasses(cardClassName, [
      'bg-card',
      'text-card-foreground',
      'rounded-xl',
      'border-border',
    ]);
    expect(cardClassName).not.toContain(' shadow');
    expect(cardTitleClassName).toBe('type-heading');
    expect(cardDescriptionClassName).toBe('type-body text-muted-foreground');
  });

  it('uses canonical field fill, border, and focus treatment', () => {
    expectClasses(inputClassName, [
      'bg-input-background',
      'border-input',
      'text-base',
      'md:text-sm',
      'h-control-default',
      'focus-visible:border-ring',
      'focus-visible:ring-ring/50',
      'focus-visible:ring-[3px]',
    ]);
    expect(inputClassName).not.toContain('bg-input/30');
    expect(inputClassName).not.toContain('shadow-xs');
    expect(inputClassName).not.toContain('type-body');

    expectClasses(textareaClassName, [
      'bg-input-background',
      'border-input',
      'focus-visible:border-ring',
      'focus-visible:ring-ring/50',
      'focus-visible:ring-[3px]',
    ]);
    expect(textareaClassName).not.toContain('bg-background');
    expect(textareaClassName).not.toContain('ring-offset');
  });

  it('aligns button defaults with Kilo action roles', () => {
    expectClasses(buttonVariants(), [
      'type-label',
      'bg-primary',
      'text-primary-foreground',
      'h-control-default',
      'px-3.5',
      'focus-visible:ring-ring/50',
    ]);
    expectClasses(buttonVariants({ variant: 'secondary' }), [
      'border-border',
      'bg-secondary',
      'text-secondary-foreground',
      'hover:bg-accent',
    ]);
    expectClasses(buttonVariants({ variant: 'outline' }), [
      'border-border',
      'bg-transparent',
      'hover:bg-accent',
    ]);
  });

  it('uses pill badge geometry and semantic status surfaces', () => {
    expectClasses(badgeVariants(), ['type-label', 'rounded-full', 'bg-primary']);
    expectClasses(badgeVariants({ variant: 'new' }), [
      'rounded-full',
      'bg-status-success-surface',
      'text-status-success',
      'border-status-success-border',
    ]);
    expectClasses(badgeVariants({ variant: 'destructive' }), [
      'rounded-full',
      'bg-status-destructive-surface',
      'text-status-destructive',
      'border-status-destructive-border',
    ]);
  });

  it('uses canonical floating overlay surface, radius, and padding', () => {
    for (const className of [popoverContentClassName, hoverCardContentClassName]) {
      expectClasses(className, ['bg-popover', 'rounded-lg', 'border-border', 'p-3', 'shadow-none']);
      expect(className).not.toContain('rounded-md');
      expect(className).not.toContain('p-4');
      expect(className).not.toContain('shadow-md');
    }
  });

  it('replaces raw black dialog and sheet scrims with semantic surfaces', () => {
    expectClasses(dialogOverlayClassName, ['bg-surface-inset/80']);
    expect(dialogOverlayClassName).not.toContain('bg-black');
    expectClasses(dialogContentClassName, ['bg-card', 'rounded-xl', 'border-border', 'p-6']);
    expect(dialogTitleClassName).toBe('type-heading');
    expect(dialogDescriptionClassName).toBe('type-body text-muted-foreground');

    expectClasses(sheetOverlayClassName, ['bg-surface-inset/70']);
    expectClasses(sheetDismissibleOverlayClassName, ['bg-surface-inset/70']);
    expect(sheetOverlayClassName).not.toContain('bg-black');
    expect(sheetDismissibleOverlayClassName).not.toContain('bg-black');
    expectClasses(sheetContentClassName, ['bg-card', 'text-card-foreground', 'border-border']);
    expect(sheetTitleClassName).toBe('type-heading text-foreground');
    expect(sheetDescriptionClassName).toBe('type-body text-muted-foreground');
  });

  it('sets table density and interaction surfaces', () => {
    expectClasses(tableRowClassName, [
      'h-12',
      'hover:bg-surface-hover',
      'data-[state=selected]:bg-surface-selected',
    ]);
    expectClasses(tableHeadClassName, ['type-label', 'h-12', 'text-muted-foreground']);
    expectClasses(tableCellClassName, ['px-3', 'py-3']);
  });

  it('uses primary-tinted active sidebar rows without yellow text', () => {
    const menuButtonClassName = sidebarMenuButtonVariants();

    expectClasses(menuButtonClassName, [
      'hover:bg-sidebar-accent',
      'data-[active=true]:bg-primary/10',
      'data-[active=true]:text-sidebar-accent-foreground',
    ]);
    expect(menuButtonClassName).not.toContain('data-[active=true]:bg-surface-selected');
    expect(menuButtonClassName).not.toContain('data-[active=true]:bg-sidebar-accent');
    expect(menuButtonClassName).not.toContain('data-[active=true]:shadow');
    expect(menuButtonClassName).not.toContain('data-[active=true]:text-primary');

    expectClasses(sidebarMenuSubButtonClassName, [
      'hover:bg-sidebar-accent',
      'data-[active=true]:bg-primary/10',
      'data-[active=true]:text-sidebar-accent-foreground',
    ]);
    expect(sidebarMenuSubButtonClassName).not.toContain('data-[active=true]:bg-surface-selected');
    expect(sidebarMenuSubButtonClassName).not.toContain('data-[active=true]:bg-sidebar-accent');
    expect(sidebarMenuSubButtonClassName).not.toContain('data-[active=true]:shadow');
    expect(sidebarMenuSubButtonClassName).not.toContain('data-[active=true]:text-primary');
  });
});
