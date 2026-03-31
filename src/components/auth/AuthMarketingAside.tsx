import LogosSection from '@/components/LogosSection';

export function AuthMarketingAside() {
  return (
    <aside className="hidden min-h-screen flex-1 flex-shrink flex-col items-center justify-center px-16 xl:flex">
      <div className="relative flex flex-col gap-12">
        <ul className="prose-lg flex flex-col gap-4">
          <li className="flex items-center gap-4">
            <div className="flex-1">
              Build, ship, and iterate faster with the{' '}
              <span className="font-bold">most popular open source coding agent</span>
            </div>
          </li>
          <li className="flex items-center gap-4">
            <div className="flex-1">
              Use Kilo in all popular IDEs{' '}
              <span className="font-bold">(VS Code/JetBrains), CLI, Cloud, and App Builder</span>
            </div>
          </li>
          <li className="flex items-center gap-4">
            <div className="flex-1">
              Access <span className="font-bold">500+ AI models</span>, including Claude Sonnet 4.6,
              GPT-5.4, Gemini 3.1, and hundreds more
            </div>
          </li>
          <li className="flex items-center gap-4">
            <div className="flex-1">
              <span className="font-bold">Fully open source</span>, transparent pricing and no
              vendor lock-in
            </div>
          </li>
        </ul>

        <LogosSection />
      </div>
    </aside>
  );
}
