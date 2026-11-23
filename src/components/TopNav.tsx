import type { AppView } from '../types/transcript';

interface TopNavProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  onNewTranscript: () => void;
}

const NAV_ITEMS: Array<{ id: AppView; label: string }> = [
  { id: 'studio', label: 'Studio' },
  { id: 'analysis', label: 'Gen AI Analysis' },
];

export function TopNav({ activeView, onSelectView, onNewTranscript }: TopNavProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[#E2E8F0] bg-white/95 backdrop-blur-xs">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single-element Brand Wordmark */}
        <button
          type="button"
          onClick={() => onSelectView('studio')}
          className="shrink-0 whitespace-nowrap font-[var(--font-display)] text-lg font-bold tracking-tight text-[#0F172A] transition-colors hover:text-[#E11D48] cursor-pointer"
        >
          CueScript
        </button>

        {/* Zone 2: Concise single-line text navigation links */}
        <nav
          aria-label="Primary navigation"
          className="flex h-full items-center gap-5 sm:gap-7"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectView(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex h-full shrink-0 items-center whitespace-nowrap text-sm font-medium transition-colors duration-150 cursor-pointer ${
                  isActive
                    ? 'text-[#0F172A]'
                    : 'text-[#475569] hover:text-[#0F172A]'
                }`}
              >
                {item.label}
                {isActive && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 h-[2px] bg-[#E11D48]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={onNewTranscript}
            className="whitespace-nowrap rounded-lg bg-[#0F172A] px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#1E293B] cursor-pointer"
          >
            New Transcript
          </button>
        </div>
      </div>
    </header>
  );
}
