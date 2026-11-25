import React, { useEffect, useState } from 'react';
import { RotateCcw, Wallet, Zap } from 'lucide-react';
import {
  AI_PROVIDER_OPTIONS,
  BROKER_FEEDS,
  type AiProviderMode,
  type BrokerFeedId,
  type EaConfig,
} from '../types/trading.ts';

interface EaSettingsViewProps {
  config: EaConfig;
  currentSimBalance: number;
  isMt5Live: boolean;
  aiHealth?: {
    geminiKeySlots: number;
    keySlotNames: string[];
    hasAirforceKey: boolean;
    airforceModel: string;
    hasOpenRouterKey: boolean;
    openRouterModel: string;
  } | null;
  onUpdateConfig: (patch: Partial<EaConfig>) => void;
  onSetSimBalance: (newBalance: number, syncInitialBalance?: boolean) => void;
  onResetAccount: () => void;
}

const BALANCE_PRESETS = [250, 500, 700, 1000, 5000, 10000];

export const EaSettingsView: React.FC<EaSettingsViewProps> = ({
  config,
  currentSimBalance,
  isMt5Live,
  aiHealth,
  onUpdateConfig,
  onSetSimBalance,
  onResetAccount,
}) => {
  const [balanceInput, setBalanceInput] = useState<string>(String(currentSimBalance));
  const [balanceSavedToast, setBalanceSavedToast] = useState(false);

  useEffect(() => {
    setBalanceInput(String(currentSimBalance));
  }, [currentSimBalance]);

  const applyCustomBalance = (val: number) => {
    if (!Number.isFinite(val) || val < 1) return;
    onSetSimBalance(val, true);
    setBalanceInput(String(Number(val.toFixed(2))));
    setBalanceSavedToast(true);
    setTimeout(() => setBalanceSavedToast(false), 2000);
  };

  const applyScalpingPreset = () => {
    onUpdateConfig({
      strategyFocus: 'ADAPTIVE_SCALP',
      analyzeCadence: '30S',
      fullAiControl: true,
      minConfidence: 76,
      useTrailingStop: true,
      trailingAtrMultiplier: 0.9,
      useBreakeven: true,
      breakevenTriggerUsd: 1.2,
      maxOpenPositions: 2,
    });
  };

  return (
    <div className="max-w-4xl mx-auto p-4 lg:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.08] pb-4">
        <div>
          <h1 className="text-xl font-semibold text-[#F8FAFC]">
            Parameter Expert Advisor XAU/USD M5
          </h1>
          <p className="text-xs text-[#94A3B8] mt-1">
            Atur modal balance simulasi, manajemen risiko, referensi harga broker, interval pemindaian Gemini, strategi scalping, dan proteksi breakeven/trailing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={applyScalpingPreset}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-[#D4AF37]/15 border border-[#D4AF37]/50 text-[#D4AF37] hover:bg-[#D4AF37]/25 transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Preset Fokus Scalping</span>
          </button>
          <button
            type="button"
            onClick={onResetAccount}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-md border border-white/[0.1] bg-[#111620] text-[#E6EDF3] hover:bg-[#161C28] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Saldo &amp; Riwayat</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Strategi & Frekuensi Gemini */}
        <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-[#F8FAFC] border-b border-white/[0.06] pb-2.5">
            Strategi, Broker &amp; Jadwal Analisa Gemini
          </h2>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#E6EDF3]">
              Referensi Harga Broker (Chart &amp; AI Feed)
            </label>
            <select
              value={config.brokerFeed ?? 'PEPPERSTONE'}
              onChange={(e) =>
                onUpdateConfig({
                  brokerFeed: e.target.value as BrokerFeedId,
                })
              }
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
            >
              {BROKER_FEEDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.tvSymbol ? `${b.name} — ${b.tvSymbol}` : `${b.name} — ${b.description}`}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#E6EDF3]">
              Fokus Strategi M5 / M1
            </label>
            <select
              value={config.strategyFocus}
              onChange={(e) =>
                onUpdateConfig({
                  strategyFocus: e.target.value as EaConfig['strategyFocus'],
                })
              }
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
            >
              <option value="ADAPTIVE_SCALP">
                Auto Adaptive AI: Momentum M5 vs Micro Breakout M1+M5 (AI Bebas Memutuskan)
              </option>
              <option value="SCALPING_EMA">Scalping Momentum M5 (EMA 9/21/50 + Tight ATR)</option>
              <option value="ULTRA_SCALP">Ultra-Scalping M1 + M5 (Sniper Micro Breakout)</option>
              <option value="LIQUIDITY_SMC">Smart Money Concepts (Liquidity Sweep &amp; BOS)</option>
              <option value="BALANCED">Balanced Confluence (EMA + RSI + MACD + Price Action)</option>
            </select>
            {config.strategyFocus === 'ADAPTIVE_SCALP' && (
              <p className="text-[11px] text-[#10B981] leading-relaxed">
                AI bebas memutuskan sendiri apakah memakai Momentum M5 atau Micro Breakout M1+M5 tanpa batasan angka winrate tertentu—selama AI yakin setup akan WIN berdasarkan analisanya sendiri, eksekusi langsung dijalankan, dan HOLD jika AI ragu.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#E6EDF3]">
              Interval Auto-Scan Chart
            </label>
            <select
              value={config.analyzeCadence}
              onChange={(e) =>
                onUpdateConfig({
                  analyzeCadence: e.target.value as EaConfig['analyzeCadence'],
                })
              }
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
            >
              <option value="30S">Setiap 30 Detik — Chart M5 (Rekomendasi Scalping)</option>
              <option value="60S">Setiap 60 Detik — Chart M5</option>
              <option value="180S">Setiap 3 Menit — Chart M5</option>
              <option value="CANDLE_CLOSE">Setiap Candle M5 Tutup (5 Menit — Chart M5)</option>
              <option value="900S">Setiap 15 Menit — Chart M15 (Hemat Token)</option>
              <option value="1800S">Setiap 30 Menit — Chart M30 (Lebih Hemat Token)</option>
              <option value="3600S">Setiap 60 Menit / 1 Jam — Chart H1 (Super Hemat Token)</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#E6EDF3]">
              Pemilihan Engine AI (Provider Analisa)
            </label>
            <select
              value={config.aiProvider ?? 'AUTO'}
              onChange={(e) =>
                onUpdateConfig({
                  aiProvider: e.target.value as AiProviderMode,
                })
              }
              className="w-full px-3 py-2 text-xs rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
            >
              {AI_PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            {aiHealth && (
              <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                Key Terdeteksi — Gemini:{' '}
                <span className={aiHealth.geminiKeySlots > 0 ? 'text-[#10B981]' : 'text-[#F59E0B]'}>
                  {aiHealth.geminiKeySlots > 0
                    ? `${aiHealth.geminiKeySlots} slot (${aiHealth.keySlotNames.join(', ') || 'GEMINI_API_KEY'})`
                    : 'Set GEMINI_API_KEY'}
                </span>{' '}
                · Airforce:{' '}
                <span className={aiHealth.hasAirforceKey ? 'text-[#10B981]' : 'text-[#F59E0B]'}>
                  {aiHealth.hasAirforceKey
                    ? `Aktif (${aiHealth.airforceModel})`
                    : 'Set AIRFORCE_API_KEY'}
                </span>{' '}
                · OpenRouter:{' '}
                <span className={aiHealth.hasOpenRouterKey ? 'text-[#10B981]' : 'text-[#F59E0B]'}>
                  {aiHealth.hasOpenRouterKey
                    ? `Aktif (${aiHealth.openRouterModel})`
                    : 'Set OPENROUTER_API_KEY di Secrets'}
                </span>
              </p>
            )}
          </div>

          <div className="p-3 rounded-md bg-[#0B0E14] border border-[#D4AF37]/30 flex items-center justify-between gap-3 text-xs">
            <div>
              <span className="font-semibold text-[#F8FAFC]">
                Deep Learning + Thinking HIGH (Multi-Engine)
              </span>
              <p className="text-[11px] text-[#94A3B8] mt-0.5 leading-relaxed">
                Mengaktifkan penalaran level HIGH pada Gemini 4 (Hydrogen &amp; Argon), DeepSeek V3 (Airforce), serta OpenRouter (<code>respan/span-01-lite:free</code>, <code>perplexity/pplx-decider-flash-v1.3:free</code>, mode bergantian cepat Span-01 ↔ PPLX dengan auto-takeover jika lambat, <code>heygen/heygen-decision-1-turbo</code>, <code>nace-ai/drex-max</code>, <code>typesafe/jev-1.14</code>, <code>google/gemini-4-argon</code>, <code>google/gemini-4-hydrogen</code>, <code>nvidia/nemotron-3-ultra-550b-a55b:free</code>, <code>moonshotai/kimi-k3.1-pro</code>) beserta ekstraksi k-NN 220 candle, Kaufman ER, Slope, dan Order Flow.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.aiThinkingHigh ?? true}
              onClick={() => onUpdateConfig({ aiThinkingHigh: !(config.aiThinkingHigh ?? true) })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                (config.aiThinkingHigh ?? true)
                  ? 'bg-[#D4AF37] border-[#D4AF37]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  (config.aiThinkingHigh ?? true) ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>

          <div className="p-3 rounded-md bg-[#0B0E14] border border-[#10B981]/30 flex items-center justify-between gap-3 text-xs">
            <div>
              <span className="font-semibold text-[#F8FAFC]">
                Keputusan AI Mandiri (Indikator Hanya Penunjang)
              </span>
              <p className="text-[11px] text-[#94A3B8] mt-0.5 leading-relaxed">
                AI memutuskan sendiri <strong className="text-[#E6EDF3]">BUY / SELL / HOLD</strong> secara mandiri dari struktur harga &amp; chart tanpa wajib menuruti indikator. EMA/RSI/MACD hanya data penunjang opsional.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.fullAiControl ?? true}
              onClick={() => onUpdateConfig({ fullAiControl: !(config.fullAiControl ?? true) })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                (config.fullAiControl ?? true)
                  ? 'bg-[#10B981] border-[#10B981]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  (config.fullAiControl ?? true) ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <label className="font-medium text-[#E6EDF3]">
                Minimum Confidence Auto-Eksekusi
              </label>
              <span className="font-mono tabular-nums text-[#D4AF37]">
                {(config.fullAiControl ?? true) ? 'Bypass (100% AI)' : `${config.minConfidence}%`}
              </span>
            </div>
            <input
              type="range"
              min={55}
              max={95}
              step={1}
              disabled={config.fullAiControl ?? true}
              value={config.minConfidence}
              onChange={(e) => onUpdateConfig({ minConfidence: Number(e.target.value) })}
              className="w-full accent-[#D4AF37] disabled:opacity-40"
            />
            <p className="text-[11px] text-[#94A3B8]">
              {(config.fullAiControl ?? true)
                ? 'Nonaktifkan "100% Kendali AI" di atas jika ingin membatasi eksekusi dengan threshold confidence manual.'
                : 'EA hanya mengeksekusi order otomatis jika skor keyakinan Gemini memenuhi ambang batas ini.'}
            </p>
          </div>

          <div className="space-y-1.5 pt-2 border-t border-white/[0.06]">
            <div className="flex items-center justify-between text-xs">
              <label className="font-medium text-[#E6EDF3]">
                Pengali ATR Trailing Stop
              </label>
              <span className="font-mono tabular-nums text-[#D4AF37]">
                {config.trailingAtrMultiplier.toFixed(1)}x ATR
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={config.trailingAtrMultiplier}
              onChange={(e) =>
                onUpdateConfig({ trailingAtrMultiplier: Number(e.target.value) })
              }
              className="w-full accent-[#D4AF37]"
            />
            <p className="text-[11px] text-[#94A3B8]">
              Untuk scalping cepat XAU/USD disarankan 0.8x - 1.0x ATR agar profit cepat terkunci.
            </p>
          </div>
        </section>

        {/* Risk & Position Sizing */}
        <section className="bg-[#111620] border border-white/[0.08] rounded-lg p-5 space-y-4">
          <h2 className="text-sm font-semibold text-[#F8FAFC] border-b border-white/[0.06] pb-2.5">
            Manajemen Risiko &amp; Proteksi Scalping
          </h2>

          {/* Custom Simulation Balance Editor */}
          <div className="p-3.5 rounded-md bg-[#0B0E14] border border-[#D4AF37]/30 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="sim-balance-input"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F8FAFC]"
              >
                <Wallet className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>Balance / Modal Akun Simulasi (USD)</span>
              </label>
              {balanceSavedToast && (
                <span className="text-[11px] font-medium text-[#10B981]">
                  Balance diperbarui
                </span>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                applyCustomBalance(Number(balanceInput));
              }}
              className="flex items-center gap-2"
            >
              <div className="relative flex-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#D4AF37]">
                  $
                </span>
                <input
                  id="sim-balance-input"
                  type="number"
                  min={1}
                  step="any"
                  value={balanceInput}
                  onChange={(e) => setBalanceInput(e.target.value)}
                  className="w-full pl-7 pr-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#111620] border border-white/[0.12] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
                  placeholder="Contoh: 700"
                />
              </div>
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0E14] hover:bg-[#E5C158] transition-colors shrink-0"
              >
                Terapkan Balance
              </button>
            </form>

            <div className="flex flex-wrap gap-1.5">
              {BALANCE_PRESETS.map((preset) => {
                const isActive = Math.abs(currentSimBalance - preset) < 0.01;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => applyCustomBalance(preset)}
                    className={`px-2 py-1 text-[11px] font-mono tabular-nums rounded border transition-colors ${
                      isActive
                        ? 'bg-[#D4AF37]/20 border-[#D4AF37] text-[#D4AF37] font-semibold'
                        : 'bg-[#111620] border-white/[0.08] text-[#94A3B8] hover:text-[#F8FAFC] hover:border-white/20'
                    }`}
                  >
                    ${preset.toLocaleString('en-US')}
                  </button>
                );
              })}
            </div>

            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              {isMt5Live
                ? 'Saat MT5 Live tersambung, terminal menampilkan Balance asli akun MT5 Anda. Nilai di atas tetap tersimpan untuk mode Simulasi Web.'
                : 'Mengubah balance akan langsung menyesuaikan modal aktif, kalkulasi lot dinamis (% Risk), serta acuan Equity di Performa.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#E6EDF3]">
              Metode Ukuran Lot
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onUpdateConfig({ lotMode: 'RISK_PERCENT' })}
                className={`py-2 px-3 text-xs font-medium rounded-md border transition-colors ${
                  config.lotMode === 'RISK_PERCENT'
                    ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#F8FAFC]'
                    : 'bg-[#0B0E14] border-white/[0.08] text-[#94A3B8]'
                }`}
              >
                Dinamis (% Risk)
              </button>
              <button
                type="button"
                onClick={() => onUpdateConfig({ lotMode: 'FIXED_LOT' })}
                className={`py-2 px-3 text-xs font-medium rounded-md border transition-colors ${
                  config.lotMode === 'FIXED_LOT'
                    ? 'bg-[#D4AF37]/15 border-[#D4AF37] text-[#F8FAFC]'
                    : 'bg-[#0B0E14] border-white/[0.08] text-[#94A3B8]'
                }`}
              >
                Fixed Lot
              </button>
            </div>
          </div>

          {config.lotMode === 'RISK_PERCENT' ? (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#E6EDF3]">
                Risiko Per Trade (% dari Balance)
              </label>
              <input
                type="number"
                min={0.1}
                max={5}
                step={0.1}
                value={config.riskPercent}
                onChange={(e) =>
                  onUpdateConfig({ riskPercent: Math.max(0.1, Number(e.target.value) || 1) })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#E6EDF3]">
                Ukuran Lot Tetap (Standard 1.00 = 100 oz)
              </label>
              <input
                type="number"
                min={0.01}
                max={10}
                step={0.01}
                value={config.fixedLot}
                onChange={(e) =>
                  onUpdateConfig({ fixedLot: Math.max(0.01, Number(e.target.value) || 0.05) })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#E6EDF3]">
                Max Posisi Terbuka
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={config.maxOpenPositions}
                onChange={(e) =>
                  onUpdateConfig({
                    maxOpenPositions: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                  })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-[#E6EDF3]">
                Batas Rugi Harian (%)
              </label>
              <input
                type="number"
                min={1}
                max={25}
                step={0.5}
                value={config.maxDailyLossPercent}
                onChange={(e) =>
                  onUpdateConfig({
                    maxDailyLossPercent: Math.max(1, Number(e.target.value) || 5),
                  })
                }
                className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md bg-[#0B0E14] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
          </div>

          <div className="p-3 rounded-md bg-[#0B0E14] border border-[#D4AF37]/40 flex items-center justify-between text-xs gap-3">
            <div>
              <span className="font-semibold text-[#D4AF37]">
                Mode 100% Tanpa SL (AI Exit Judge)
              </span>
              <p className="text-[11px] text-[#94A3B8] mt-0.5 leading-relaxed">
                Order dibuka murni tanpa Stop Loss (SL = 0), Take Profit tetap aktif. Saat ada posisi terbuka, AI otomatis memantau sesuai timeframe chart dan hanya melakukan Close All jika peluang win &lt; 20% serta ada indikasi harga berubah arah dengan keyakinan ≥ 80%. Selama posisi masih dijaga (KEEP), AI menahan sinyal berlawanan arah agar tidak hedging/tabrakan.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.noSlAiExit ?? true}
              onClick={() => onUpdateConfig({ noSlAiExit: !(config.noSlAiExit ?? true) })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                (config.noSlAiExit ?? true)
                  ? 'bg-[#D4AF37] border-[#D4AF37]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  (config.noSlAiExit ?? true) ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>

          <div className="p-3.5 rounded-md bg-[#0B0E14] border border-[#10B981]/30 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="font-semibold text-[#10B981]">
                  Layering Searah &amp; Martil (Keyakinan ≥ {config.sameSideMinConfidence ?? 80}%)
                </span>
                <p className="text-[11px] text-[#94A3B8] mt-0.5 leading-relaxed">
                  Jika posisi aktif masih KEEP dan AI kembali memberi sinyal searah dengan keyakinan tinggi, EA membuka posisi ke-2 (atau Martil) lalu otomatis menyamakan TP keduanya ke target probabilitas tersentuh minimal 85%.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={config.allowSameSideLayering ?? true}
                onClick={() =>
                  onUpdateConfig({
                    allowSameSideLayering: !(config.allowSameSideLayering ?? true),
                  })
                }
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                  (config.allowSameSideLayering ?? true)
                    ? 'bg-[#10B981] border-[#10B981]'
                    : 'bg-[#1E293B] border-white/15'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                    (config.allowSameSideLayering ?? true) ? 'translate-x-4' : 'translate-x-0.5'
                  } mt-[1px]`}
                />
              </button>
            </div>

            {(config.allowSameSideLayering ?? true) && (
              <div className="pt-2.5 border-t border-white/[0.06] space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label
                      htmlFor="same-side-conf-input"
                      className="block text-[11px] font-medium text-[#E6EDF3]"
                    >
                      Min Keyakinan Layer (%)
                    </label>
                    <input
                      id="same-side-conf-input"
                      type="number"
                      min={75}
                      max={95}
                      step={1}
                      value={config.sameSideMinConfidence ?? 80}
                      onChange={(e) =>
                        onUpdateConfig({
                          sameSideMinConfidence: Math.max(
                            75,
                            Math.min(95, Number(e.target.value) || 80)
                          ),
                        })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums rounded bg-[#111620] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#10B981]"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-[#E6EDF3]">
                        Mode Martil Lot
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={config.martingaleEnabled ?? true}
                        onClick={() =>
                          onUpdateConfig({
                            martingaleEnabled: !(config.martingaleEnabled ?? true),
                          })
                        }
                        className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors ${
                          (config.martingaleEnabled ?? true)
                            ? 'bg-[#D4AF37] border-[#D4AF37]'
                            : 'bg-[#1E293B] border-white/15'
                        }`}
                      >
                        <span
                          className={`pointer-events-none inline-block h-3 w-3 transform rounded-full bg-[#0B0E14] transition-transform ${
                            (config.martingaleEnabled ?? true) ? 'translate-x-3' : 'translate-x-0.5'
                          } mt-[1px]`}
                        />
                      </button>
                    </div>
                    <input
                      type="number"
                      min={1.0}
                      max={5.0}
                      step={0.1}
                      disabled={!(config.martingaleEnabled ?? true)}
                      value={config.martingaleMultiplier ?? 2.0}
                      onChange={(e) =>
                        onUpdateConfig({
                          martingaleMultiplier: Math.max(
                            1.0,
                            Math.min(5.0, Number(e.target.value) || 2.0)
                          ),
                        })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-mono tabular-nums rounded bg-[#111620] border border-white/[0.1] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37] disabled:opacity-40"
                    />
                  </div>
                </div>

                {(config.martingaleEnabled ?? true) && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[#94A3B8]">Preset Pengali Martil:</span>
                    <div className="flex items-center gap-1.5">
                      {[1.0, 1.5, 2.0, 2.5].map((mult) => {
                        const isActive =
                          Math.abs((config.martingaleMultiplier ?? 2.0) - mult) < 0.05;
                        return (
                          <button
                            key={mult}
                            type="button"
                            onClick={() => onUpdateConfig({ martingaleMultiplier: mult })}
                            className={`px-2 py-0.5 text-[11px] font-mono tabular-nums rounded border transition-colors ${
                              isActive
                                ? 'bg-[#D4AF37]/20 border-[#D4AF37] text-[#D4AF37] font-semibold'
                                : 'bg-[#111620] border-white/[0.08] text-[#94A3B8] hover:text-[#F8FAFC]'
                            }`}
                          >
                            {mult.toFixed(1)}x
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div
            className={`pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs gap-3 ${
              (config.noSlAiExit ?? true) ? 'opacity-45' : ''
            }`}
          >
            <div>
              <span className="font-medium text-[#E6EDF3]">
                Auto Breakeven+ Scalping{' '}
                {(config.noSlAiExit ?? true) ? '(Bypass di Mode Tanpa SL)' : ''}
              </span>
              <p className="text-[11px] text-[#94A3B8]">
                Kunci SL ke entry +$0.20 saat profit mencapai ${(config.breakevenTriggerUsd ?? 1.2).toFixed(2)}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              disabled={config.noSlAiExit ?? true}
              aria-checked={config.useBreakeven ?? true}
              onClick={() => onUpdateConfig({ useBreakeven: !(config.useBreakeven ?? true) })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                (config.useBreakeven ?? true)
                  ? 'bg-[#D4AF37] border-[#D4AF37]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  (config.useBreakeven ?? true) ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>

          <div
            className={`pt-2 border-t border-white/[0.06] flex items-center justify-between text-xs gap-3 ${
              (config.noSlAiExit ?? true) ? 'opacity-45' : ''
            }`}
          >
            <div>
              <span className="font-medium text-[#E6EDF3]">
                ATR Trailing Stop Otomatis{' '}
                {(config.noSlAiExit ?? true) ? '(Bypass di Mode Tanpa SL)' : ''}
              </span>
              <p className="text-[11px] text-[#94A3B8]">
                Geser Stop Loss otomatis ke profit saat harga bergerak &ge; {config.trailingAtrMultiplier}x ATR
              </p>
            </div>
            <button
              type="button"
              role="switch"
              disabled={config.noSlAiExit ?? true}
              aria-checked={config.useTrailingStop}
              onClick={() => onUpdateConfig({ useTrailingStop: !config.useTrailingStop })}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                config.useTrailingStop
                  ? 'bg-[#D4AF37] border-[#D4AF37]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  config.useTrailingStop ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
};
