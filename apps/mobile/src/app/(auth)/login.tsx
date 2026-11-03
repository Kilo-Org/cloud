import { useTranslation } from 'react-i18next';
import { LoginScreen } from '@/components/login-screen';

export default function LoginRoute() {
  const { i18n } = useTranslation();
  return <LoginScreen key={i18n.language} />;
}
