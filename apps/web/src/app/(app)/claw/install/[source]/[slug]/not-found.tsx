import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';

/**
 * Friendly not-found for the install route. Rendered when the install page
 * calls notFound(): unknown source, a byte missing or removed upstream, a
 * failed signature verification, or a slug mismatch. Replaces the bare default
 * 404 with a clear message and a way back into the app.
 */
export default function InstallNotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg items-center px-6 py-12">
      <Card className="w-full text-left">
        <CardHeader>
          <CardTitle className="text-xl break-words">This install link isn’t available</CardTitle>
          <CardDescription className="leading-relaxed">
            This ClawByte could not be found, or it is no longer available. It may have been
            removed, or the link may be incorrect. You can browse the catalog on kilo.ai, or head
            back to your chat.
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-end">
          <Button asChild>
            <Link href="/claw/chat">Back to chat</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
