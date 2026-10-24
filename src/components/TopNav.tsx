import { Download } from 'lucide-react';

export type ActiveTab = 'workspace' | 'profiler' | 'colab';

interface TopNavProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onDownloadNotebook: () => void;
}

const NAV_ITEMS: { id: ActiveTab; label: string }[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'profiler', label: 'Data Profiler' },
  { id: 'colab', label: 'Colab Notebook' },
];

export function TopNav({
  activeTab,
  onSelectTab,
  onDownloadNotebook,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-8 px-6 h-16">
        {/* Zone 1: Single text element Brand wordmark */}
        <button
          type="button"
          onClick={() => onSelectTab('workspace')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600"
        >
          MyQuery Agent
        </button>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="Primary Navigation"
          className="flex items-center gap-6 overflow-x-auto text-sm font-medium"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`py-5 border-b-2 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isActive
                    ? 'border-blue-600 text-slate-900 font-semibold'
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onDownloadNotebook}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <Download className="w-3.5 h-3.5 shrink-0" />
            <span>Download .ipynb</span>
          </button>
        </div>
      </div>
    </header>
  );
}
