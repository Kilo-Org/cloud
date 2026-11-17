/* eslint-disable no-literal-copy/no-literal-copy -- Development-only design-system fixture: one screen shows every primitive the layout contract names, and its long-text rows are the copy under test. */
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';

import { ScreenHeader } from '@/components/screen-header';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChoiceRow } from '@/components/ui/choice-row';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Fab } from '@/components/ui/fab';
import { FormField } from '@/components/ui/form-field';
import { Bell, Inbox, Settings, Sparkles, Trash2 } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { ScreenFooter } from '@/components/ui/screen-footer';
import { Section } from '@/components/ui/section';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SessionRow } from '@/components/ui/session-row';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

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
  const [scope, setScope] = useState<'personal' | 'organization'>('personal');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Design system" />
      <ScrollView contentContainerClassName={SCREEN_BODY_CLASS} showsVerticalScrollIndicator={false}>
        <Section
          label="Section header"
          actionLabel="Action"
          onActionPress={() => undefined}
          reserveLabelAir
        >
          <Card>
            <Text>Card: one surface, inner gap, never nested.</Text>
          </Card>
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
            <ConfigureRow icon={Inbox} title={LONG_TITLE} subtitle={LONG_VALUE} onPress={() => undefined} />
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
            <ChoiceRow label={LONG_TITLE} description={LONG_VALUE} selected={false} onPress={() => undefined} />
          </RowGroup>
        </Section>

        <Section label="Flat list rows">
          <View>
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
          </RowGroup>
          <View>
            <RowSkeleton variant="session" subtitle />
            <RowSkeleton variant="session" last />
          </View>
        </Section>

        <Section label="Empty state">
          <EmptyState
            icon={Inbox}
            title="Nothing here"
            description="The state's way out sits under it."
            placement="static"
            action={
              <Button variant="outline">
                <Text>Action</Text>
              </Button>
            }
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
          <FormField label="Field with an error" defaultValue="Value" error="This value is refused" />
          <FormField label={LONG_TITLE} defaultValue={LONG_VALUE} />
        </Section>

        <Section label="Segmented control">
          <SegmentedControl
            accessibilityLabel="Scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'personal', label: 'Personal' },
              { value: 'organization', label: 'Organization' },
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
