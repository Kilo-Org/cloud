import { InvalidRouteState } from '@/components/invalid-route-state';

export default function NotFound() {
  return <InvalidRouteState backTo="/" />;
}
