import React, { useState } from 'react';
import { X } from 'lucide-react';
import type {
  ClosedTrade,
  EaAnalysisResult,
  MarketQuote,
  OpenPosition,
} from '../types/trading.ts';
import { calculateXauPnl } from '../utils/indicators.ts';

interface PositionsDrawerProps {
  openPositions: OpenPosition[];
  closedTrades: ClosedTrade[];
  analysisLogs: EaAnalysisResult[];
  quote: MarketQuote | null;
  onClosePosition: (id: string) => void;
  onCloseAll: () => void;
}

type DrawerTab = 'open' | 'history' | 'logs';

export const PositionsDrawer: React.FC<PositionsDrawerProps> = ({
  openPositions,
  closedTrades,
  analysisLogs,
  quote,
  onClosePosition,
  onCloseAll,
}) => {
  const [tab, setTab] = useState<DrawerTab>('open');

  return (
    <section className="bg-[#111620] border border-white/[0.08] rounded-lg overflow-hidden">
      {/* Header Tabs */}
      <div className="px-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
        <div className="flex items-center gap-6 text-xs font-medium">
          <button
            type="button"
            onClick={() => setTab('open')}
            className={`relative py-3 transition-colors whitespace-nowrap ${
              tab === 'open' ? 'text-[#F8FAFC]' : 'text-[#94A3B8] hover:text-[#E6EDF3]'
            }`}
          >
            Posisi Terbuka ({openPositions.length})
            {tab === 'open' && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#D4AF37]" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`relative py-3 transition-colors whitespace-nowrap ${
              tab === 'history' ? 'text-[#F8FAFC]' : 'text-[#94A3B8] hover:text-[#E6EDF3]'
            }`}
          >
            Riwayat Trade ({closedTrades.length})
            {tab === 'history' && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#D4AF37]" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setTab('logs')}
            className={`relative py-3 transition-colors whitespace-nowrap ${
              tab === 'logs' ? 'text-[#F8FAFC]' : 'text-[#94A3B8] hover:text-[#E6EDF3]'
            }`}
          >
            Log Analisa Gemini ({analysisLogs.length})
            {tab === 'logs' && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#D4AF37]" />
            )}
          </button>
        </div>

        {tab === 'open' && openPositions.length > 0 && (
          <button
            type="button"
            onClick={onCloseAll}
            className="px-3 py-1 text-xs font-medium rounded border border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors whitespace-nowrap"
          >
            Tutup Semua
          </button>
        )}
      </div>

      {/* Table Area */}
      <div className="overflow-x-auto max-h-64">
        {tab === 'open' && (
          <>
            {openPositions.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-[#94A3B8]">
                Belum ada posisi XAU/USD terbuka. Aktifkan Auto Eksekusi atau buka order dari panel kanan.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/[0.06] text-[#94A3B8] font-medium">
                    <th className="py-2.5 px-4">Waktu</th>
                    <th className="py-2.5 px-3">Arah</th>
                    <th className="py-2.5 px-3 text-right">Lot</th>
                    <th className="py-2.5 px-3 text-right">Entry</th>
                    <th className="py-2.5 px-3 text-right">SL</th>
                    <th className="py-2.5 px-3 text-right">TP</th>
                    <th className="py-2.5 px-3 text-right">Harga Kini</th>
                    <th className="py-2.5 px-3">Sumber</th>
                    <th className="py-2.5 px-3 text-right">Floating P&amp;L</th>
                    <th className="py-2.5 px-4 text-right">Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                  {openPositions.map((pos) => {
                    const mark = quote
                      ? pos.side === 'BUY'
                        ? quote.bid
                        : quote.ask
                      : pos.entryPrice;
                    const pnl = calculateXauPnl(pos.side, pos.lots, pos.entryPrice, mark);
                    return (
                      <tr key={pos.id} className="hover:bg-white/[0.02]">
                        <td className="py-2.5 px-4 text-[#94A3B8]">
                          {new Date(pos.openedAt).toLocaleTimeString('id-ID')}
                        </td>
                        <td
                          className={`py-2.5 px-3 font-semibold ${
                            pos.side === 'BUY' ? 'text-[#10B981]' : 'text-[#EF4444]'
                          }`}
                        >
                          {pos.side}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#F8FAFC]">
                          {pos.lots.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#E6EDF3]">
                          {pos.entryPrice.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#EF4444]">
                          {pos.stopLoss > 0 ? (
                            <>
                              {pos.stopLoss.toFixed(2)}
                              {pos.trailingActivated ? ' (TS)' : ''}
                            </>
                          ) : (
                            <span className="text-[#D4AF37] font-sans text-[11px]">Tanpa SL (AI)</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#10B981]">
                          {pos.takeProfit.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#E6EDF3]">
                          {mark.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3 font-sans text-[#94A3B8]">
                          {pos.source === 'MT5_LIVE'
                            ? 'MT5 Live'
                            : pos.source === 'AI_AUTO'
                            ? 'EA Auto'
                            : pos.source === 'AI_MANUAL'
                            ? 'Sinyal AI'
                            : 'Manual'}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-semibold ${
                            pnl >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'
                          }`}
                        >
                          {pnl >= 0 ? '+' : '-'}${Math.abs(pnl).toFixed(2)}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => onClosePosition(pos.id)}
                            aria-label="Tutup posisi"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/[0.1] text-[#E6EDF3] hover:bg-white/[0.06] font-sans text-[11px]"
                          >
                            <X className="w-3 h-3" />
                            <span>Tutup</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

        {tab === 'history' && (
          <>
            {closedTrades.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-[#94A3B8]">
                Riwayat eksekusi trade masih kosong. Posisi yang ditutup oleh TP, SL, atau manual akan tercatat di sini.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/[0.06] text-[#94A3B8] font-medium">
                    <th className="py-2.5 px-4">Waktu Tutup</th>
                    <th className="py-2.5 px-3">Arah</th>
                    <th className="py-2.5 px-3 text-right">Lot</th>
                    <th className="py-2.5 px-3 text-right">Entry</th>
                    <th className="py-2.5 px-3 text-right">Close</th>
                    <th className="py-2.5 px-3">Alasan</th>
                    <th className="py-2.5 px-4 text-right">Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05] font-mono tabular-nums">
                  {closedTrades.slice(0, 30).map((t) => (
                    <tr key={t.id} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 px-4 text-[#94A3B8]">
                        {new Date(t.closedAt).toLocaleTimeString('id-ID')}
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
          </>
        )}

        {tab === 'logs' && (
          <>
            {analysisLogs.length === 0 ? (
              <div className="py-10 px-4 text-center text-xs text-[#94A3B8]">
                Belum ada riwayat analisa Gemini M5. Jalankan analisa pertama untuk melihat log keputusan EA.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/[0.06] text-[#94A3B8] font-medium">
                    <th className="py-2.5 px-4">Waktu</th>
                    <th className="py-2.5 px-3">Sinyal</th>
                    <th className="py-2.5 px-3 text-right">Conf</th>
                    <th className="py-2.5 px-3 text-right">Harga</th>
                    <th className="py-2.5 px-3 text-right">SL / TP1</th>
                    <th className="py-2.5 px-3">Pola / Setup</th>
                    <th className="py-2.5 px-4">Ringkasan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {analysisLogs.slice(0, 30).map((log) => (
                    <tr key={log.id} className="hover:bg-white/[0.02]">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleTimeString('id-ID')}
                      </td>
                      <td
                        className={`py-2.5 px-3 font-mono font-semibold whitespace-nowrap ${
                          log.signal === 'BUY'
                            ? 'text-[#10B981]'
                            : log.signal === 'SELL'
                            ? 'text-[#EF4444]'
                            : 'text-[#F59E0B]'
                        }`}
                      >
                        <div>{log.signal}</div>
                        {log.positionDecision && log.positionDecision !== 'NONE' && (
                          <div
                            className={`text-[10px] font-medium ${
                              log.positionDecision === 'KEEP'
                                ? 'text-[#D4AF37]'
                                : 'text-[#EF4444]'
                            }`}
                          >
                            {log.positionDecision}
                          </div>
                        )}
                        {log.postTpEvaluation && log.postTpEvaluation !== 'NONE' && (
                          <div
                            className={`text-[10px] font-medium ${
                              log.postTpEvaluation === 'RE_ENTRY_CONTINUATION'
                                ? 'text-[#10B981]'
                                : log.postTpEvaluation === 'EXHAUSTION_SKIP'
                                ? 'text-[#EF4444]'
                                : 'text-[#F59E0B]'
                            }`}
                          >
                            {log.postTpEvaluation === 'RE_ENTRY_CONTINUATION'
                              ? 'POST-TP: LANJUT'
                              : log.postTpEvaluation === 'EXHAUSTION_SKIP'
                              ? 'POST-TP: JENUH'
                              : 'POST-TP: HOLD'}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-right text-[#E6EDF3]">
                        {log.confidence}%
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-right text-[#E6EDF3]">
                        {log.priceAtAnalysis.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-right text-[#94A3B8] whitespace-nowrap">
                        {log.stopLoss.toFixed(2)} / {log.takeProfit1.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 text-[#E6EDF3] max-w-[200px] truncate">
                        {log.setupPattern}
                      </td>
                      <td className="py-2.5 px-4 text-[#94A3B8] max-w-md truncate">
                        {log.summary}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </section>
  );
};
