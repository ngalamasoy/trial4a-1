import React, { useMemo, useState } from 'react';
import type { ClosedTrade } from '../types/trading.ts';

interface HistoryAnalyticsViewProps {
  closedTrades: ClosedTrade[];
  initialBalance: number;
  currentBalance: number;
}

export const HistoryAnalyticsView: React.FC<HistoryAnalyticsViewProps> = ({
  closedTrades,
  initialBalance,
  currentBalance,
}) => {
  const [filterSide, setFilterSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');

  const stats = useMemo(() => {
    const total = closedTrades.length;
    const wins = closedTrades.filter((t) => t.pnlUsd > 0);
    const losses = closedTrades.filter((t) => t.pnlUsd < 0);
    const grossProfit = wins.reduce((acc, t) => acc + t.pnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.pnlUsd, 0));
    const netPnl = currentBalance - initialBalance;
    const winRate = total > 0 ? (wins.length / total) * 100 : 0;
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

    // Build chronological equity points
    const chronological = [...closedTrades].sort((a, b) => a.closedAt - b.closedAt);
    const points = [initialBalance];
    let running = initialBalance;
    let peak = initialBalance;
    let maxDrawdownPct = 0;

    for (const t of chronological) {
      running += t.pnlUsd;
      points.push(running);
      if (running > peak) peak = running;
      const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    return {
      total,
      wins: wins.length,
      losses: losses.length,
      netPnl,
      winRate,
      profitFactor,
      maxDrawdownPct,
      points,
    };
  }, [closedTrades, initialBalance, currentBalance]);

  const filteredTrades = useMemo(() => {
    if (filterSide === 'ALL') return closedTrades;
    return closedTrades.filter((t) => t.side === filterSide);
  }, [closedTrades, filterSide]);

  // SVG Equity Curve
  const svgChart = useMemo(() => {
    const pts = stats.points;
    const width = 800;
    const height = 200;
    const padX = 12;
    const padY = 16;

    const minVal = Math.min(...pts);
    const maxVal = Math.max(...pts);
    const range = maxVal - minVal || 100;

    const coords = pts.map((val, idx) => {
      const x =
        pts.length === 1
          ? width / 2
          : padX + (idx / (pts.length - 1)) * (width - padX * 2);
      const y = height - padY - ((val - minVal) / range) * (height - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return { width, height, polyline: coords.join(' '), minVal, maxVal };
  }, [stats.points]);

  return (
    <div className="max-w-6xl mx-auto p-4 lg:p-6 space-y-6">
      <div className="border-b border-white/[0.08] pb-4">
        <h1 className="text-xl font-semibold text-[#F8FAFC]">
          Performa &amp; Jurnal Trading XAU/USD M5
        </h1>
        <p className="text-xs text-[#94A3B8] mt-1">
          Evaluasi kurva ekuitas, win rate, profit factor, dan riwayat eksekusi Expert Advisor.
        </p>
      </div>

      {/* 4-column KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/[0.08] border border-white/[0.08] rounded-lg overflow-hidden">
        <div className="bg-[#111620] p-4">
          <div className="text-xs text-[#94A3B8]">Net Profit / Loss</div>
          <div
            className={`text-xl font-mono tabular-nums font-semibold mt-1 ${
              stats.netPnl >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'
            }`}
          >
            {stats.netPnl >= 0 ? '+' : '-'}${Math.abs(stats.netPnl).toFixed(2)}
          </div>
        </div>
        <div className="bg-[#111620] p-4">
          <div className="text-xs text-[#94A3B8]">Win Rate</div>
          <div className="text-xl font-mono tabular-nums font-semibold text-[#F8FAFC] mt-1">
            {stats.winRate.toFixed(1)}%
            <span className="text-xs font-normal text-[#94A3B8] ml-2">
              ({stats.wins}W / {stats.losses}L)
            </span>
          </div>
        </div>
        <div className="bg-[#111620] p-4">
          <div className="text-xs text-[#94A3B8]">Profit Factor</div>
          <div className="text-xl font-mono tabular-nums font-semibold text-[#D4AF37] mt-1">
            {stats.profitFactor.toFixed(2)}
          </div>
        </div>
        <div className="bg-[#111620] p-4">
          <div className="text-xs text-[#94A3B8]">Max Drawdown</div>
          <div className="text-xl font-mono tabular-nums font-semibold text-[#E6EDF3] mt-1">
            {stats.maxDrawdownPct.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Equity Curve */}
      <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between text-xs">
          <h2 className="text-sm font-semibold text-[#F8FAFC]">Kurva Ekuitas Akun</h2>
          <span className="font-mono tabular-nums text-[#94A3B8]">
            Modal Awal: ${initialBalance.toFixed(2)} · Kini: ${currentBalance.toFixed(2)}
          </span>
        </div>

        <div className="w-full h-48 bg-[#0B0E14] border border-white/[0.06] rounded-md p-2">
          {stats.points.length < 2 ? (
            <div className="h-full flex items-center justify-center text-xs text-[#94A3B8]">
              Kurva ekuitas akan terbentuk setelah minimal 1 posisi ditutup.
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${svgChart.width} ${svgChart.height}`}
              className="w-full h-full"
              preserveAspectRatio="none"
            >
              <polyline
                fill="none"
                stroke="#D4AF37"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={svgChart.polyline}
              />
            </svg>
          )}
        </div>
      </section>

      {/* Trade Journal Table */}
      <section className="bg-[#111620] border border-white/[0.08] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[#F8FAFC]">Jurnal Eksekusi</h2>
          <div className="flex items-center gap-1 p-1 bg-[#0B0E14] border border-white/[0.08] rounded-md text-xs">
            {(['ALL', 'BUY', 'SELL'] as const).map((side) => (
              <button
                key={side}
                type="button"
                onClick={() => setFilterSide(side)}
                className={`px-3 py-1 rounded transition-colors ${
                  filterSide === side
                    ? 'bg-[#1E293B] text-[#F8FAFC] font-medium'
                    : 'text-[#94A3B8] hover:text-[#E6EDF3]'
                }`}
              >
                {side === 'ALL' ? 'Semua' : side}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          {filteredTrades.length === 0 ? (
            <div className="py-12 text-center text-xs text-[#94A3B8]">
              Belum ada riwayat trade yang tercatat.
            </div>
          ) : (
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-white/[0.06] text-[#94A3B8] font-medium">
                  <th className="py-2.5 px-4">Tutup</th>
                  <th className="py-2.5 px-3">Arah</th>
                  <th className="py-2.5 px-3 text-right">Lot</th>
                  <th className="py-2.5 px-3 text-right">Entry</th>
                  <th className="py-2.5 px-3 text-right">Close</th>
                  <th className="py-2.5 px-3">Alasan</th>
                  <th className="py-2.5 px-3">Sumber</th>
                  <th className="py-2.5 px-4 text-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                {filteredTrades.map((t) => (
                  <tr key={t.id} className="hover:bg-white/[0.02]">
                    <td className="py-2.5 px-4 text-[#94A3B8]">
                      {new Date(t.closedAt).toLocaleString('id-ID')}
                    </td>
                    <td
                      className={`py-2.5 px-3 font-semibold ${
                        t.side === 'BUY' ? 'text-[#10B981]' : 'text-[#EF4444]'
                      }`}
                    >
                      {t.side}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[#F8FAFC]">
                      {t.lots.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[#E6EDF3]">
                      {t.entryPrice.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[#E6EDF3]">
                      {t.closePrice.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-3 font-sans text-[#94A3B8]">{t.closeReason}</td>
                    <td className="py-2.5 px-3 font-sans text-[#94A3B8]">{t.source}</td>
                    <td
                      className={`py-2.5 px-4 text-right font-semibold ${
                        t.pnlUsd >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'
                      }`}
                    >
                      {t.pnlUsd >= 0 ? '+' : '-'}${Math.abs(t.pnlUsd).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
};
