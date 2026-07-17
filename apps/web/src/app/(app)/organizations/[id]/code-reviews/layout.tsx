import { PylonWidget } from '@/components/pylon-widget';
import { PylonSupportButton } from '@/components/pylon-support-button';

export default function OrgCodeReviewsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <PylonWidget>
        <PylonSupportButton />
      </PylonWidget>
    </>
  );
}
