import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const meta: Meta<typeof Table> = {
  title: 'Components/Data Display/Table',
  component: Table,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const usageRows = [
  { session: 'Storybook QA', model: 'GPT-5.5', cost: '$4.20', selected: true },
  { session: 'Billing review', model: 'Claude Opus 4.8', cost: '$7.14', selected: false },
  { session: 'Docs cleanup', model: 'Gemini 3.5', cost: '$1.88', selected: false },
] as const;

export const Usage: Story = {
  render: () => (
    <div className="w-[640px] rounded-xl border border-border bg-card p-4">
      <Table>
        <TableCaption>Model usage for active sessions.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Session</TableHead>
            <TableHead>Model</TableHead>
            <TableHead className="text-right">Cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {usageRows.map(row => (
            <TableRow key={row.session} data-state={row.selected ? 'selected' : undefined}>
              <TableCell className="font-medium">{row.session}</TableCell>
              <TableCell>{row.model}</TableCell>
              <TableCell className="text-right tabular-nums">{row.cost}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Total</TableCell>
            <TableCell className="text-right tabular-nums">$13.22</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  ),
};
