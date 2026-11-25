import React from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton.tsx';

export type ActiveTab = 'terminal' | 'analytics' | 'settings' | 'bridge';

interface TopBarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onAnalyzeNow: () => void;
  isAnalyzing: boolean;
}

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'analytics', label: 'Performa' },
  { id: 'settings', label: 'Parameter EA' },
  { id: 'bridge', label: 'Akun & MT5' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onAnalyzeNow,
  isAnalyzing,
}) => {
  return (
    <header className="h-14 border-b border-white/[0.08] bg-[#0B0E14] px-3 sm:px-4 lg:px-6 flex items-center justify-between gap-3 sm:gap-6">
      {/* Zone 1: Single-element Wordmark */}
      <button
        type="button"
        onClick={() => onSelectTab('terminal')}
        className="text-lg font-bold tracking-tight text-[#F8FAFC] whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] rounded"
      >
        Aurum<span className="text-[#D4AF37]">EA</span>
      </button>

      {/* Zone 2: Desktop navigation links (mobile uses native bottom bar) */}
      <nav aria-label="Navigasi utama" className="hidden md:flex items-center gap-6 overflow-x-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] ${
                isActive ? 'text-[#F8FAFC]' : 'text-[#94A3B8] hover:text-[#E6EDF3]'
              }`}
            >
              {item.label}
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#D4AF37]" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Android PWA Install + Primary Analyze CTA */}
      <div className="flex items-center gap-2 shrink-0">
        <PWAInstallButton />
        <button
          type="button"
          onClick={onAnalyzeNow}
          disabled={isAnalyzing}
          className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0E14] hover:bg-[#E5B842] disabled:opacity-60 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F8FAFC]"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="hidden sm:inline">Menganalisa M5...</span>
              <span className="sm:hidden">Analisa...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Analisa Chart</span>
              <span className="sm:hidden">Analisa</span>
            </>
          )}
        </button>
      </div>
    </header>
  );
};
