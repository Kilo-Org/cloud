/* eslint-disable max-lines, no-literal-copy/no-literal-copy -- Development-only design-system fixture: one screen shows every primitive the layout contract names, and its long-text rows are the copy under test. */
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ScreenHeader } from '@/components/screen-header';
import { SheetHeader } from '@/components/sheet-header';
import { EmptyState, StateAction } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChoiceRow } from '@/components/ui/choice-row';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Fab } from '@/components/ui/fab';
import { FormField } from '@/components/ui/form-field';
import { Bell, Inbox, Plus, Settings, Sparkles, Trash2 } from '@/components/ui/icons';
import { Input, INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { InputFrame } from '@/components/ui/input-frame';
import { KvRow } from '@/components/ui/kv-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowFrame } from '@/components/ui/row-frame';
import { RowGroup, RowGroupItem } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { ScreenFooter } from '@/components/ui/screen-footer';
import { Section } from '@/components/ui/section';
import { SectionHeaderSkeleton } from '@/components/ui/section-header-skeleton';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SessionRow } from '@/components/ui/session-row';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

const LONG_TITLE =
  'A name long enough that the row has to decide where it truncates instead of squeezing the value beside it';
const LONG_VALUE =
  'features/a-branch-name-long-enough-to-ellipsize-in-every-language-the-app-ships';

/**
 * Development-only target of the design gate for anything under
 * `components/ui` (`apps/mobile/AGENTS.md`, "Layout contract").
 *
 * It renders each primitive in one scrolling page, and one row of each carries
 * the long-text case, so a truncation or a spacing change is measurable without
 * hunting a real screen for the state. Open it with
 * `kiloapp:///(auth)/design-system-fixture`. No API call, account or stored
 * state.
 */
export function DesignSystemFixture() {
  const router = useRouter();
  const [switchOn, setSwitchOn] = useState(true);
  const [choice, setChoice] = useState<'balanced' | 'lenient'>('balanced');
  const [scope, setScope] = useState<'personal' | 'organization' | 'plan'>('personal');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Design system" />
      <ScrollView
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <Section
          label="Section header"
          icon={<Inbox size={14} className="text-muted-foreground" />}
          actionLabel="Action"
          actionTestID="fixture-section-action"
          onActionPress={() => undefined}
          reserveLabelAir
        >
          <Card>
            <Text>Card: one surface, inner gap, never nested.</Text>
          </Card>
        </Section>

        <Section
          label="Disabled action"
          actionLabel="Manage"
          actionDisabled
          onActionPress={() => undefined}
        >
          <Card>
            <Text>The action keeps its frame while it cannot respond.</Text>
          </Card>
        </Section>

        <Section
          label="Full-bleed header"
          actionLabel="See all"
          onActionPress={() => undefined}
          inset
        >
          <Text variant="caption">
            An inset header draws the page gutter over a full-bleed list.
          </Text>
        </Section>

        <Section label="Row frame">
          <RowGroup leadingTile>
            <RowFrame
              icon={Sparkles}
              title="Link row"
              subtitle={{ text: 'An external destination rather than a pushed screen' }}
              secondSubtitle={{
                text: 'owner/repo#128-with-a-long-reference',
                face: 'mono',
                numberOfLines: 1,
                ellipsizeMode: 'middle',
              }}
              trailing={{ kind: 'chevron' }}
              accessibilityRole="link"
              onPress={() => undefined}
            />
            <RowFrame
              title="Trailing nodes"
              subtitle={{ text: 'Two marks share the trailing cell' }}
              trailing={{
                kind: 'nodes',
                nodes: [
                  <Text key="version" variant="caption">
                    v1.2.3
                  </Text>,
                  <Text key="state" variant="caption">
                    Active
                  </Text>,
                ],
              }}
            />
            <RowFrame
              title="Switch with its own handle"
              subtitle={{ text: 'The switch keeps the row tap off it' }}
              trailing={{
                kind: 'switch',
                value: switchOn,
                onValueChange: setSwitchOn,
                testID: 'fixture-row-switch',
              }}
              pressTarget="content"
            />
            <RowFrame
              icon={Bell}
              title="Mono value"
              subtitle={{ text: 'A value that keeps its extension visible' }}
              trailing={{
                kind: 'value',
                text: LONG_VALUE,
                face: 'mono',
                ellipsizeMode: 'middle',
              }}
              onPress={() => undefined}
            />
            <RowFrame
              stack
              icon={Settings}
              title={LONG_TITLE}
              subtitle={{ text: LONG_VALUE }}
              secondSubtitle={{ text: 'The stacked frame puts the tile above the text.' }}
              trailing={{ kind: 'chevron' }}
              onPress={() => undefined}
            />
          </RowGroup>
        </Section>

        <Section label="Virtualized group">
          <View>
            <RowGroupItem position="first" leadingTile>
              <RowFrame
                icon={Settings}
                title="First row"
                trailing={{ kind: 'chevron' }}
                onPress={() => undefined}
              />
            </RowGroupItem>
            <RowGroupItem position="middle" leadingTile>
              <RowFrame
                icon={Bell}
                title="Middle row"
                trailing={{ kind: 'chevron' }}
                onPress={() => undefined}
              />
            </RowGroupItem>
            <RowGroupItem position="last" leadingTile>
              <RowFrame icon={Trash2} title="Last row" onPress={() => undefined} />
            </RowGroupItem>
          </View>
        </Section>

        <Section label="Navigation rows">
          <RowGroup leadingTile>
            <ConfigureRow
              icon={Settings}
              title="Navigation row"
              subtitle="Subtitle"
              onPress={() => undefined}
            />
            <ConfigureRow
              icon={Sparkles}
              title="Action row"
              subtitle="Runs in place, so no chevron"
              variant="action"
              onPress={() => undefined}
            />
            <ConfigureRow
              icon={Trash2}
              title="Destructive row"
              onPress={() => undefined}
              destructive
            />
            <ConfigureRow
              icon={Inbox}
              title={LONG_TITLE}
              subtitle={LONG_VALUE}
              onPress={() => undefined}
            />
          </RowGroup>
        </Section>

        <Section label="Preference and value">
          <RowGroup leadingTile>
            <PreferenceRow
              icon={Bell}
              title="Preference row"
              subtitle="A switch row keeps its own state"
              value={switchOn}
              disabled={false}
              onValueChange={setSwitchOn}
            />
            <PreferenceRow
              icon={Bell}
              title={LONG_TITLE}
              subtitle={LONG_VALUE}
              value={false}
              disabled
              onValueChange={() => undefined}
            />
            <KvRow label="Version" value="1.2.3" />
            <KvRow label={LONG_TITLE} value={LONG_VALUE} />
          </RowGroup>
        </Section>

        <Section label="Choice rows">
          <RowGroup>
            <ChoiceRow
              label="Balanced"
              description="Selection mark from RowCheck"
              selected={choice === 'balanced'}
              onPress={() => {
                setChoice('balanced');
              }}
            />
            <ChoiceRow
              label="Lenient"
              selected={choice === 'lenient'}
              onPress={() => {
                setChoice('lenient');
              }}
            />
            <ChoiceRow
              label={LONG_TITLE}
              description={LONG_VALUE}
              selected={false}
              onPress={() => undefined}
            />
          </RowGroup>
        </Section>

        <Section label="Flat list rows">
          {/* The flat row owns the page gutter itself, so the list leaves the
              body's own inset instead of adding a second one. */}
          <View className="-mx-4">
            <SessionRow
              agentLabel="platform"
              agentState="platform"
              title="A session row"
              subtitle="branch/name"
              meta="$0.0041 · 12 MINUTES AGO"
              live
              metaWhileLive
            />
            <SessionRow
              agentLabel={LONG_TITLE}
              title={LONG_TITLE}
              subtitle={LONG_VALUE}
              meta="$0.0041 · 12 MINUTES AGO"
            />
            <SessionRow agentLabel="repository" agentState="repository" title="The last row" last />
          </View>
        </Section>

        <Section label="Loading rows">
          <RowGroup>
            <RowSkeleton tile subtitle />
            <RowSkeleton lines={3} trailingControl />
            <RowSkeleton tile trailing="switch" />
            <RowSkeleton stack tile subtitle />
          </RowGroup>
          <View className="-mx-4">
            <RowSkeleton variant="session" subtitle />
            <RowSkeleton variant="session" last />
          </View>
        </Section>

        <Section label="Loading header">
          <SectionHeaderSkeleton action reserveLabelAir />
          <SectionHeaderSkeleton action />
        </Section>

        <Section label="Sheet header">
          <View className="gap-4">
            <SheetHeader
              title="Edit repository"
              eyebrow="owner/repo#128"
              onDone={() => undefined}
              onCancel={() => undefined}
              topInset="never"
            />
            <SheetHeader
              title="Saving changes"
              eyebrow="owner/repo#128"
              onDone={() => undefined}
              onCancel={() => undefined}
              doneBusy
              topInset="never"
            />
            <SheetHeader
              title="Share session"
              variant="close"
              onDone={() => undefined}
              topInset="never"
            />
          </View>
        </Section>

        <Section label="Card without padding">
          <Card padding="none">
            <View className="gap-1 p-4">
              <Text variant="caption">Balance</Text>
              <Text variant="figure">$12.40</Text>
            </View>
            <View className="border-t-[0.5px] border-hair-soft p-4">
              <Text variant="caption">
                A bare surface: each layer owns its inset, and the card clips them to its radius.
              </Text>
            </View>
          </Card>
        </Section>

        <Section label="Stat tiles">
          <View className="flex-row gap-3">
            <Card className="flex-1">
              <Text variant="caption">Credits used</Text>
              <Text variant="stat">12.4k</Text>
            </Card>
            <Card className="flex-1">
              <Text variant="caption">Credits left</Text>
              <Text variant="stat">7.6k</Text>
            </Card>
          </View>
        </Section>

        <Section label="Empty state">
          <EmptyState
            icon={Inbox}
            title="Nothing here"
            description="The state's way out sits under it."
            placement="static"
            action={<StateAction label="Action" icon={Plus} onPress={() => undefined} />}
          />
        </Section>

        <Section label="Buttons">
          <View className="flex-row flex-wrap gap-3">
            <Button size="sm">
              <Text>Default sm</Text>
            </Button>
            <Button>
              <Text>Default</Text>
            </Button>
            <Button size="lg" variant="outline">
              <Text>Outline lg</Text>
            </Button>
            <Button variant="outline-destructive" size="sm">
              <Text>Destructive</Text>
            </Button>
            <Button variant="secondary" size="sm">
              <Text>Secondary</Text>
            </Button>
            <Button variant="ghost" size="sm">
              <Text>Ghost</Text>
            </Button>
            <Button variant="accent-soft" size="sm">
              <Text>Accent soft</Text>
            </Button>
            <Button variant="link" size="sm">
              <Text>Link</Text>
            </Button>
            <Button loading>
              <Text>Loading</Text>
            </Button>
          </View>
        </Section>

        <Section label="Fields">
          <FormField label="Single-line field" defaultValue="Value" />
          <FormField
            label="Field with an error"
            defaultValue="Value"
            error="This value is refused"
          />
          <FormField label={LONG_TITLE} defaultValue={LONG_VALUE} />
          <Input className="rounded-md border border-border bg-card" defaultValue="A bare input" />
          <InputFrame>
            <Input
              multiline
              numberOfLines={3}
              defaultValue="A multiline field: the frame draws the chrome, the field keeps its own insets."
            />
          </InputFrame>
          <View
            className={cn(
              INPUT_BOX_SHAPE_CLASS,
              'justify-center rounded-md border border-border bg-card'
            )}
          >
            <Text numberOfLines={1} ellipsizeMode="tail">
              A read-only box that swaps with the field above
            </Text>
          </View>
        </Section>

        <Section label="Segmented control">
          <SegmentedControl
            accessibilityLabel="Scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'personal', label: 'Personal', testID: 'fixture-scope-personal' },
              {
                value: 'organization',
                label: 'Organization',
                badge: <Text variant="caption">3</Text>,
              },
              { value: 'plan', label: 'Plan', disabled: true },
            ]}
          />
        </Section>

        <Section label="Floating action">
          <View className="flex-row">
            <Fab label="New item" onPress={() => undefined} />
          </View>
        </Section>
      </ScrollView>
      <ScreenFooter>
        <Button
          onPress={() => {
            router.back();
          }}
        >
          <Text>Primary action</Text>
        </Button>
      </ScreenFooter>
    </View>
  );
}
