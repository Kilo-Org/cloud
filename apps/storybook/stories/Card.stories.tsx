import type { Meta, StoryObj } from '@storybook/nextjs';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const meta: Meta<typeof Card> = {
  title: 'Components/Data Display/Card',
  component: Card,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-[360px]">
      <CardHeader>
        <CardTitle>Agent budget</CardTitle>
        <CardDescription>Daily controls for cloud sessions.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Credits used</dt>
            <dd className="tabular-nums">$18.42</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Limit</dt>
            <dd className="tabular-nums">$40.00</dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm">Review usage</Button>
        <Button size="sm" variant="outline">
          Edit limit
        </Button>
      </CardFooter>
    </Card>
  ),
};
