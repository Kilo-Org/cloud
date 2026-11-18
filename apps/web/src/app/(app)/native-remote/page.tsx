import { notFound } from 'next/navigation';
import NativeRemotePreview from './NativeRemotePreview';

export default function NativeRemotePage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <NativeRemotePreview />;
}
