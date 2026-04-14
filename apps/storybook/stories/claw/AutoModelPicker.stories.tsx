import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { AutoModelPicker } from '@/app/(app)/claw/components/AutoModelPicker';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const SAMPLE_MODELS: ModelOption[] = [
  { id: 'kilo-auto/frontier', name: 'Kilo Auto Frontier' },
  { id: 'kilo-auto/balanced', name: 'Kilo Auto Balanced' },
  { id: 'anthropic/claude-opus-4.6', name: 'Anthropic: Claude Opus 4.6' },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
  { id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2' },
  { id: 'google/gemini-3-pro-preview', name: 'Google: Gemini 3 Pro Preview' },
  { id: 'google/gemini-3-flash-preview', name: 'Google: Gemini 3 Flash Preview' },
];

const meta: Meta<typeof AutoModelPicker> = {
  title: 'Claw/AutoModelPicker',
  component: AutoModelPicker,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    models: SAMPLE_MODELS,
    value: 'kilo-auto/frontier',
  },
  decorators: [
    Story => (
      <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Get Started with KiloClaw</CardTitle>
            <CardDescription>
              Choose a default model to provision your first KiloClaw instance.
              <br />
              7-day free trial, no credit card required
            </CardDescription>
          </CardHeader>
          <CardContent className="mt-4 space-y-6">
            <Story />
          </CardContent>
        </Card>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const FrontierSelected: Story = {
  args: {
    value: 'kilo-auto/frontier',
  },
};

export const BalancedSelected: Story = {
  args: {
    value: 'kilo-auto/balanced',
  },
};

export const NoSelection: Story = {
  args: {
    value: '',
  },
};

export const Loading: Story = {
  args: {
    models: [],
    value: '',
    isLoading: true,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const Interactive: Story = {
  args: {
    value: '',
  },
  render: function InteractivePicker(args) {
    const [value, setValue] = useState(args.value);
    return <AutoModelPicker {...args} value={value} onValueChange={setValue} />;
  },
};
