import { useDevSessionLoginCommit } from '@/components/dev-session-injector';
import { LoginScreen } from '@/components/login-screen';

export default function LoginRoute() {
  useDevSessionLoginCommit();
  return <LoginScreen />;
}
