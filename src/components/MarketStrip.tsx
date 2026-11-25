import React, { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import {
  BROKER_FEEDS,
  type BrokerFeedId,
  type ChartTimeframe,
  type IndicatorSnapshot,
  type MacroContext,
  type MarketQuote,
  type Mt5BridgeStatus,
} from '../types/trading.ts';

interface MarketStripProps {
  quote: MarketQuote | null;
  indicators: IndicatorSnapshot | null;
  macroContext?: MacroContext | null;
  brokerFeed: BrokerFeedId;
  timeframe: ChartTimeframe;
  onChangeBrokerFeed: (broker: BrokerFeedId) => void;
  balance: number;
  equity: number;
  floatingPnl: number;
  totalExposurePercent: number;
  mt5Status: Mt5BridgeStatus;
  streamConnected: boolean;
  isMt5Live: boolean;
  onUpdateSimBalance: (newBalance: number) => void;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const MarketStrip: React.FC<MarketStripProps> = ({
  quote,
  indicators,
  macroContext,
  brokerFeed,
  timeframe,
  onChangeBrokerFeed,
  balance,
  equity,
  floatingPnl,
  totalExposurePercent,
  mt5Status,
  streamConnected,
  isMt5Live,
  onUpdateSimBalance,
}) => {
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState('');

  const isPositiveChange = (quote?.change24h ?? 0) >= 0;
  const isPositiveFloating = floatingPnl >= 0;
  const activeBroker = BROKER_FEEDS.find((b) => b.id === brokerFeed);

  const startEditBalance = () => {
    setBalanceDraft(String(balance));
    setEditingBalance(true);
  };

  const commitBalanceEdit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const parsed = Number(balanceDraft);
    if (Number.isFinite(parsed) && parsed >= 1) {
      onUpdateSimBalance(parsed);
      setEditingBalance(false);
    }
  };

  return (
    <section
      aria-label="Ringkasan pasar dan akun"
      className="border-b border-white/[0.08] bg-[#111620] px-4 lg:px-6 py-2.5 flex flex-wrap items-center justify-between gap-x-8 gap-y-2 text-xs"
    >
      {/* Left: Pair, Broker Reference Selector, Live Bid/Ask, Spread, 24h Change, Candle Countdown */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-sm font-bold text-[#F8FAFC]">XAU/USD</span>
          <span className="text-[#94A3B8]">·</span>
          <span className="font-mono text-[#D4AF37] font-semibold">{timeframe}</span>
          <span className="text-[#94A3B8]">·</span>
          <label htmlFor="broker-feed-select" className="sr-only">
            Referensi Harga Broker
          </label>
          <select
            id="broker-feed-select"
            value={brokerFeed}
            onChange={(e) => onChangeBrokerFeed(e.target.value as BrokerFeedId)}
            title={activeBroker?.description || 'Pilih Referensi Harga Broker'}
            className="px-2 py-1 text-xs font-medium rounded bg-[#0B0E14] border border-[#D4AF37]/35 text-[#F8FAFC] hover:border-[#D4AF37] focus:outline-none focus:border-[#D4AF37] cursor-pointer"
          >
            {BROKER_FEEDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.tvSymbol ? `${b.name} (${b.tvSymbol})` : b.name}
              </option>
            ))}
          </select>
          <span
            className={`text-[11px] font-medium ${
              !streamConnected
                ? 'text-[#94A3B8]'
                : quote?.marketStatus === 'LIVE'
                ? 'text-[#10B981]'
                : 'text-[#F59E0B]'
            }`}
          >
            {streamConnected
              ? quote?.marketStatus === 'LIVE'
                ? 'LIVE'
                : 'DELAYED'
              : 'Menyambung...'}
          </span>
        </div>

        <div className="h-3.5 w-px bg-white/[0.08] hidden sm:block" />

        <div className="flex items-center gap-5 font-mono tabular-nums whitespace-nowrap">
          <div>
            <span className="text-[#94A3B8] mr-1.5">Bid</span>
            <span className="text-sm font-semibold text-[#F8FAFC]">
              {quote ? quote.bid.toFixed(2) : '----.--'}
            </span>
          </div>
          <div>
            <span className="text-[#94A3B8] mr-1.5">Ask</span>
            <span className="text-sm font-semibold text-[#F8FAFC]">
              {quote ? quote.ask.toFixed(2) : '----.--'}
            </span>
          </div>
          <div>
            <span className="text-[#94A3B8] mr-1.5">Spread</span>
            <span className="text-[#E6EDF3]">
              {quote ? `$${quote.spread.toFixed(2)}` : '--'}
            </span>
          </div>
          <div>
            <span className="text-[#94A3B8] mr-1.5">24j</span>
            <span className={isPositiveChange ? 'text-[#10B981]' : 'text-[#EF4444]'}>
              {quote
                ? `${isPositiveChange ? '+' : ''}${quote.change24h.toFixed(2)} (${
                    isPositiveChange ? '+' : ''
                  }${quote.changePercent24h.toFixed(2)}%)`
                : '--'}
            </span>
          </div>
          <div>
            <span className="text-[#94A3B8] mr-1.5">Tutup {timeframe}</span>
            <span className="text-[#E6EDF3]">
              {quote ? formatCountdown(quote.candleCloseInSec) : '--:--'}
            </span>
          </div>
          {indicators?.atr14 !== null && indicators?.atr14 !== undefined && (
            <div className="hidden xl:block">
              <span className="text-[#94A3B8] mr-1.5">ATR14</span>
              <span className="text-[#E6EDF3]">${indicators.atr14.toFixed(2)}</span>
            </div>
          )}
          {indicators?.rsi14 !== null && indicators?.rsi14 !== undefined && (
            <div className="hidden xl:block">
              <span className="text-[#94A3B8] mr-1.5">RSI14</span>
              <span
                className={
                  indicators.rsi14 >= 70
                    ? 'text-[#EF4444]'
                    : indicators.rsi14 <= 30
                    ? 'text-[#10B981]'
                    : 'text-[#E6EDF3]'
                }
              >
                {indicators.rsi14.toFixed(1)}
              </span>
            </div>
          )}
          {macroContext?.dxyPrice !== null && macroContext?.dxyPrice !== undefined && (
            <div className="hidden lg:block">
              <span className="text-[#94A3B8] mr-1.5">DXY</span>
              <span className="text-[#E6EDF3] font-semibold">
                {macroContext.dxyPrice.toFixed(2)}
              </span>
              {macroContext.dxyChangePct !== null && (
                <span
                  className={`ml-1 ${
                    macroContext.dxyChangePct > 0
                      ? 'text-[#EF4444]'
                      : macroContext.dxyChangePct < 0
                      ? 'text-[#10B981]'
                      : 'text-[#94A3B8]'
                  }`}
                >
                  ({macroContext.dxyChangePct >= 0 ? '+' : ''}
                  {macroContext.dxyChangePct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right: Account Mode, Risk Exposure %, Balance, Equity, Floating P&L */}
      <div className="flex flex-wrap items-center gap-5 font-mono tabular-nums whitespace-nowrap">
        <div className="font-sans">
          <span className="text-[#94A3B8] mr-1.5">Akun</span>
          <span
            className={
              mt5Status.connected
                ? 'font-semibold text-[#10B981]'
                : 'font-medium text-[#E6EDF3]'
            }
          >
            {mt5Status.connected
              ? `MT5 ${mt5Status.profile?.accountType} #${mt5Status.profile?.login}`
              : mt5Status.configured
              ? `MT5 Menunggu EA`
              : 'Simulasi Web'}
          </span>
        </div>
        <div>
          <span className="text-[#94A3B8] mr-1.5">Risk Aktif</span>
          <span
            className={`font-semibold ${
              totalExposurePercent >= 4
                ? 'text-[#EF4444]'
                : totalExposurePercent >= 2
                ? 'text-[#F59E0B]'
                : 'text-[#10B981]'
            }`}
          >
            {totalExposurePercent.toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[#94A3B8]">Balance</span>
          {!isMt5Live && editingBalance ? (
            <form onSubmit={commitBalanceEdit} className="inline-flex items-center gap-1">
              <span className="text-[#D4AF37]">$</span>
              <input
                type="number"
                min={1}
                step="any"
                autoFocus
                aria-label="Ubah Balance Simulasi"
                value={balanceDraft}
                onChange={(e) => setBalanceDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingBalance(false);
                }}
                className="w-24 px-1.5 py-0.5 text-xs font-mono tabular-nums rounded bg-[#0B0E14] border border-[#D4AF37] text-[#F8FAFC] focus:outline-none"
              />
              <button
                type="submit"
                title="Simpan Balance"
                className="p-1 rounded bg-[#10B981]/20 text-[#10B981] hover:bg-[#10B981]/30 transition-colors"
              >
                <Check className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => setEditingBalance(false)}
                title="Batal"
                className="p-1 rounded bg-white/[0.06] text-[#94A3B8] hover:text-[#F8FAFC] transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </form>
          ) : (
            <>
              <span className="font-semibold text-[#F8FAFC]">
                ${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {!isMt5Live && (
                <button
                  type="button"
                  onClick={startEditBalance}
                  title="Ubah Balance Simulasi"
                  aria-label="Ubah Balance Simulasi"
                  className="p-1 rounded text-[#94A3B8] hover:text-[#D4AF37] hover:bg-white/[0.06] transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
            </>
          )}
        </div>
        <div>
          <span className="text-[#94A3B8] mr-1.5">Equity</span>
          <span className="font-semibold text-[#F8FAFC]">
            ${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div>
          <span className="text-[#94A3B8] mr-1.5">Floating</span>
          <span
            className={`font-semibold ${
              floatingPnl === 0
                ? 'text-[#94A3B8]'
                : isPositiveFloating
                ? 'text-[#10B981]'
                : 'text-[#EF4444]'
            }`}
          >
            {floatingPnl >= 0 ? '+' : '-'}${Math.abs(floatingPnl).toFixed(2)}
          </span>
        </div>
      </div>
    </section>
  );
};
