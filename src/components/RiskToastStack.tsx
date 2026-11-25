import React from 'react';
import { AlertTriangle, Info, ShieldAlert, X } from 'lucide-react';
import type { RiskNotification } from '../types/trading.ts';

interface RiskToastStackProps {
  notifications: RiskNotification[];
  onDismiss: (id: string) => void;
}

export const RiskToastStack: React.FC<RiskToastStackProps> = ({
  notifications,
  onDismiss,
}) => {
  if (notifications.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)]"
    >
      {notifications.map((n) => {
        const borderClass =
          n.level === 'CRITICAL'
            ? 'border-[#EF4444]/50 bg-[#161218]'
            : n.level === 'WARNING'
            ? 'border-[#F59E0B]/50 bg-[#161510]'
            : 'border-[#D4AF37]/40 bg-[#111620]';

        return (
          <div
            key={n.id}
            role="status"
            className={`p-3.5 rounded-lg border shadow-xl text-xs space-y-1.5 ${borderClass}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-[#F8FAFC]">
                {n.level === 'CRITICAL' && (
                  <ShieldAlert className="w-4 h-4 text-[#EF4444] shrink-0" />
                )}
                {n.level === 'WARNING' && (
                  <AlertTriangle className="w-4 h-4 text-[#F59E0B] shrink-0" />
                )}
                {n.level === 'INFO' && (
                  <Info className="w-4 h-4 text-[#D4AF37] shrink-0" />
                )}
                <span>{n.title}</span>
              </div>
              <button
                type="button"
                onClick={() => onDismiss(n.id)}
                aria-label="Tutup notifikasi risiko"
                className="text-[#94A3B8] hover:text-[#F8FAFC] transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="text-[#CBD5E1] leading-relaxed">{n.message}</p>

            <div className="pt-1.5 border-t border-white/[0.08] flex items-center justify-between font-mono tabular-nums text-[11px]">
              <span className="text-[#94A3B8]">
                Risk Order:{' '}
                <strong className="text-[#F8FAFC]">
                  {n.tradeRiskPercent.toFixed(2)}% (${n.tradeRiskUsd.toFixed(2)})
                </strong>
              </span>
              <span className="text-[#94A3B8]">
                Total Eksposur:{' '}
                <strong
                  className={
                    n.totalExposurePercent >= 4
                      ? 'text-[#EF4444]'
                      : n.totalExposurePercent >= 2
                      ? 'text-[#F59E0B]'
                      : 'text-[#10B981]'
                  }
                >
                  {n.totalExposurePercent.toFixed(2)}%
                </strong>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
