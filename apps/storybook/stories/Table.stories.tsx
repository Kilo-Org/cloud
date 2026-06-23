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
          {[
            ['Storybook QA', 'GPT-5.5', '$4.20'],
            ['Billing review', 'Claude Opus 4.8', '$7.14'],
            ['Docs cleanup', 'Gemini 3.5', '$1.88'],
          ].map(row => (
            <TableRow key={row[0]}>
              <TableCell className="font-medium">{row[0]}</TableCell>
              <TableCell>{row[1]}</TableCell>
              <TableCell className="text-right tabular-nums">{row[2]}</TableCell>
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
