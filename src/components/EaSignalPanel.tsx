import React from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Pause,
  Play,
  Square,
  AlertTriangle,
  Eye,
} from 'lucide-react';
import {
  AI_PROVIDER_OPTIONS,
  type AiProviderMode,
  type ChartTimeframe,
  type EaAnalysisResult,
  type EaConfig,
  type MarketQuote,
  type Mt5BridgeStatus,
  type OpenPosition,
} from '../types/trading.ts';
import { calculateXauLotSize } from '../utils/indicators.ts';

interface EaSignalPanelProps {
  analysis: EaAnalysisResult | null;
  quote: MarketQuote | null;
  config: EaConfig;
  timeframe: ChartTimeframe;
  balance: number;
  atr14: number | null;
  totalExposurePercent: number;
  totalExposureUsd: number;
  openPositionsCount: number;
  openPositions: OpenPosition[];
  mt5Status: Mt5BridgeStatus;
  isAnalyzing: boolean;
  analysisError: string | null;
  autoCountdownSec: number | null;
  onToggleAutoAnalyze: () => void;
  onChangeAnalyzeCadence: (cadence: EaConfig['analyzeCadence']) => void;
  onToggleAutoExecute: () => void;
  onToggleFullAiControl: () => void;
  onChangeAiProvider: (provider: AiProviderMode) => void;
  onAnalyzeNow: () => void;
  onExecuteAiSignal: () => void;
  onQuickMarketOrder: (side: 'BUY' | 'SELL') => void;
}

function formatAutoCountdown(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${String(s).padStart(2, '0')}d`;
  }
  return `${seconds}d`;
}

export const EaSignalPanel: React.FC<EaSignalPanelProps> = ({
  analysis,
  quote,
  config,
  timeframe,
  balance,
  atr14,
  totalExposurePercent,
  totalExposureUsd,
  openPositionsCount,
  openPositions,
  mt5Status,
  isAnalyzing,
  analysisError,
  autoCountdownSec,
  onToggleAutoAnalyze,
  onChangeAnalyzeCadence,
  onToggleAutoExecute,
  onToggleFullAiControl,
  onChangeAiProvider,
  onAnalyzeNow,
  onExecuteAiSignal,
  onQuickMarketOrder,
}) => {
  const isFullAiControl = config.fullAiControl ?? true;
  const isNoSlMode = config.noSlAiExit ?? true;
  const isAutoPausedByPosition = config.autoAnalyze && openPositionsCount > 0 && !isNoSlMode;
  const isMonitoringPositions = config.autoAnalyze && openPositionsCount > 0 && isNoSlMode;
  const signalColor =
    analysis?.signal === 'BUY'
      ? 'text-[#10B981]'
      : analysis?.signal === 'SELL'
      ? 'text-[#EF4444]'
      : 'text-[#F59E0B]';

  const baseSuggestedLot =
    analysis && analysis.signal !== 'HOLD'
      ? config.lotMode === 'FIXED_LOT'
        ? config.fixedLot
        : calculateXauLotSize(balance, config.riskPercent, analysis.entryPrice, analysis.stopLoss)
      : config.fixedLot;

  const sameSidePositions =
    analysis && analysis.signal !== 'HOLD'
      ? openPositions.filter((p) => p.side === analysis.signal)
      : [];
  const oppositePositions =
    analysis && analysis.signal !== 'HOLD'
      ? openPositions.filter((p) => p.side !== analysis.signal)
      : [];
  const isSameSideLayer = Boolean(
    analysis && analysis.signal !== 'HOLD' && sameSidePositions.length > 0
  );
  const isMartilLayer = isSameSideLayer && (config.martingaleEnabled ?? true);
  const latestSameSide =
    sameSidePositions.length > 0
      ? sameSidePositions.reduce(
          (a, b) => (b.openedAt > a.openedAt ? b : a),
          sameSidePositions[0]
        )
      : null;
  const suggestedLot =
    isMartilLayer && latestSameSide
      ? Math.min(
          20,
          Math.max(
            0.01,
            Number((latestSameSide.lots * (config.martingaleMultiplier ?? 2.0)).toFixed(2))
          )
        )
      : baseSuggestedLot;
  const sameSideMinConf = config.sameSideMinConfidence ?? 80;
  const effectiveTpDisplay =
    isSameSideLayer && analysis?.highProbTp && analysis.highProbTp > 0
      ? analysis.highProbTp
      : analysis?.takeProfit1 ?? 0;

  // Compute exact % risk for the next order (AI signal if actionable, else market order)
  const atrVal = atr14 ?? 2.5;
  const isScalpMode =
    config.strategyFocus === 'ADAPTIVE_SCALP' ||
    config.strategyFocus === 'SCALPING_EMA' ||
    config.strategyFocus === 'ULTRA_SCALP';
  const strategyLabel =
    config.strategyFocus === 'ADAPTIVE_SCALP'
      ? 'Adaptive M5+M1 (AI Decide)'
      : config.strategyFocus === 'ULTRA_SCALP'
      ? 'Ultra-Scalp M1+M5'
      : config.strategyFocus === 'SCALPING_EMA'
      ? 'Scalping EMA M5'
      : config.strategyFocus === 'LIQUIDITY_SMC'
      ? 'SMC Scalp M5'
      : 'Balanced M5';

  const previewRiskSlDist =
    analysis && analysis.signal !== 'HOLD'
      ? Math.abs(analysis.entryPrice - analysis.stopLoss)
      : Number((atrVal * (isScalpMode ? 1.0 : 1.5)).toFixed(2));
  const previewLot =
    analysis && analysis.signal !== 'HOLD'
      ? suggestedLot
      : config.lotMode === 'FIXED_LOT'
      ? config.fixedLot
      : calculateXauLotSize(balance, config.riskPercent, 0, previewRiskSlDist);
  const previewRiskUsd = Number((previewRiskSlDist * previewLot * 100).toFixed(2));
  const previewRiskPct = balance > 0 ? Number(((previewRiskUsd / balance) * 100).toFixed(2)) : 0;

  return (
    <aside className="flex flex-col bg-[#111620] border border-white/[0.08] rounded-lg overflow-hidden">
      {/* EA Automation Controls Header */}
      <div className="p-4 border-b border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#F8FAFC]">
              Gemini Expert Advisor
            </h2>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              {mt5Status.connected
                ? `MT5 #${mt5Status.profile?.login}`
                : 'Simulasi Web'}{' '}
              · <span className="text-[#D4AF37]">{strategyLabel}</span>
              {isAutoPausedByPosition ? (
                <span className="text-[#F59E0B]"> · Jeda ({openPositionsCount} posisi)</span>
              ) : isMonitoringPositions ? (
                <span className="text-[#10B981]">
                  {' '}
                  · Pantau {timeframe}
                  {autoCountdownSec !== null ? ` (${formatAutoCountdown(autoCountdownSec)})` : ''}
                </span>
              ) : autoCountdownSec !== null && config.autoAnalyze ? (
                ` · ${formatAutoCountdown(autoCountdownSec)}`
              ) : (
                ''
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleAutoAnalyze}
            title={
              isAutoPausedByPosition
                ? 'Auto Scan dijeda sementara karena ada posisi terbuka (hemat token). Akan aktif otomatis saat semua posisi tertutup.'
                : isMonitoringPositions
                ? `Mode 100% Tanpa SL aktif: AI terus memantau posisi terbuka setiap interval chart ${timeframe} dan hanya close jika tren berbalik/berpotensi lose.`
                : undefined
            }
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 ${
              isAutoPausedByPosition
                ? 'bg-[#F59E0B]/15 text-[#F59E0B] border-[#F59E0B]/40'
                : isMonitoringPositions
                ? 'bg-[#D4AF37]/15 text-[#D4AF37] border-[#D4AF37]/50'
                : config.autoAnalyze
                ? 'bg-[#10B981]/15 text-[#10B981] border-[#10B981]/40'
                : 'bg-[#161C28] text-[#94A3B8] border-white/[0.08] hover:text-[#F8FAFC]'
            }`}
          >
            {isAutoPausedByPosition ? (
              <>
                <Pause className="w-3 h-3" />
                <span>Jeda (Hemat Token)</span>
              </>
            ) : isMonitoringPositions ? (
              <>
                <Eye className="w-3 h-3" />
                <span>Pantau {timeframe}</span>
              </>
            ) : config.autoAnalyze ? (
              <>
                <Square className="w-3 h-3 fill-current" />
                <span>Auto Scan Aktif</span>
              </>
            ) : (
              <>
                <Play className="w-3 h-3 fill-current" />
                <span>Mulai Auto Scan</span>
              </>
            )}
          </button>
        </div>

        {/* Auto-Execution & 100% AI Judge Switches */}
        <div className="space-y-2 pt-2 border-t border-white/[0.06] text-xs">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[#E6EDF3] font-medium">Keputusan AI Mandiri</span>
              <span className="text-[#D4AF37] ml-1.5 font-medium">
                {isFullAiControl ? '(Indikator Penunjang)' : '(Filter Conf)'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isFullAiControl}
              onClick={onToggleFullAiControl}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                isFullAiControl
                  ? 'bg-[#10B981] border-[#10B981]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  isFullAiControl ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <span className="text-[#E6EDF3] font-medium">Auto Eksekusi Order</span>
              <span className="text-[#94A3B8] ml-1.5">
                {isFullAiControl ? '(Langsung ikut vonis AI)' : `(Conf ≥ ${config.minConfidence}%)`}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.autoExecute}
              onClick={onToggleAutoExecute}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                config.autoExecute
                  ? 'bg-[#D4AF37] border-[#D4AF37]'
                  : 'bg-[#1E293B] border-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[#0B0E14] transition-transform ${
                  config.autoExecute ? 'translate-x-4' : 'translate-x-0.5'
                } mt-[1px]`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label htmlFor="panel-cadence-select" className="text-[#E6EDF3] font-medium">
              Interval Auto-Scan
            </label>
            <select
              id="panel-cadence-select"
              value={config.analyzeCadence}
              onChange={(e) =>
                onChangeAnalyzeCadence(e.target.value as EaConfig['analyzeCadence'])
              }
              className="px-2 py-1 text-[11px] rounded bg-[#0B0E14] border border-white/[0.12] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37] cursor-pointer"
            >
              <option value="30S">30 Detik (Chart M5)</option>
              <option value="60S">60 Detik (Chart M5)</option>
              <option value="180S">3 Menit (Chart M5)</option>
              <option value="CANDLE_CLOSE">5 Menit (Chart M5 Close)</option>
              <option value="900S">15 Menit (Chart M15)</option>
              <option value="1800S">30 Menit (Chart M30)</option>
              <option value="3600S">60 Menit (Chart H1)</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-2">
            <label htmlFor="panel-ai-provider-select" className="text-[#E6EDF3] font-medium">
              Engine AI ({(config.aiThinkingHigh ?? true) ? 'Thinking High' : 'Std'})
            </label>
            <select
              id="panel-ai-provider-select"
              value={config.aiProvider ?? 'AUTO'}
              onChange={(e) => onChangeAiProvider(e.target.value as AiProviderMode)}
              className="px-2 py-1 text-[11px] rounded bg-[#0B0E14] border border-white/[0.12] text-[#F8FAFC] focus:outline-none focus:border-[#D4AF37] cursor-pointer max-w-[195px]"
            >
              {AI_PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.shortLabel}
                </option>
              ))}
            </select>
          </div>

          {/* Automatic Live Chart Vision & OCR Status */}
          <div className="pt-1.5 border-t border-white/[0.06] flex items-center justify-between gap-2 text-[11px]">
            <span className="text-[#E6EDF3] font-medium inline-flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>Chart Vision &amp; OCR</span>
            </span>
            <span className="text-[#10B981] font-medium">
              Otomatis dari Live Chart
            </span>
          </div>
        </div>
      </div>

      {/* Error State */}
      {analysisError && (
        <div className="mx-4 mt-4 p-3 rounded-md bg-[#EF4444]/10 border border-[#EF4444]/30 text-xs text-[#FCA5A5] flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-[#EF4444] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-[#EF4444]">Analisa AI Gagal</p>
            <p className="leading-relaxed">{analysisError}</p>
          </div>
        </div>
      )}

      {/* Main Signal Readout */}
      <div className="p-4 flex-1 flex flex-col justify-between gap-4">
        {!analysis ? (
          <div className="py-10 text-center space-y-3">
            <p className="text-sm font-medium text-[#E6EDF3]">
              Siap Menganalisa Chart {timeframe}
            </p>
            <p className="text-xs text-[#94A3B8] leading-relaxed max-w-xs mx-auto">
              Klik <strong className="text-[#F8FAFC]">Analisa Chart</strong> untuk mengirim snapshot visual chart candlestick dan data indikator teknikal {timeframe} ke endpoint Gemini.
            </p>
            <button
              type="button"
              onClick={onAnalyzeNow}
              disabled={isAnalyzing}
              className="px-4 py-2 text-xs font-semibold rounded-md bg-[#D4AF37] text-[#0B0E14] hover:bg-[#E5B842] disabled:opacity-60 transition-colors"
            >
              {isAnalyzing ? 'Sedang Menganalisa...' : 'Jalankan Analisa Pertama'}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Signal Header */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  {analysis.signal === 'BUY' && (
                    <ArrowUpRight className="w-5 h-5 text-[#10B981]" />
                  )}
                  {analysis.signal === 'SELL' && (
                    <ArrowDownRight className="w-5 h-5 text-[#EF4444]" />
                  )}
                  {analysis.signal === 'HOLD' && (
                    <Minus className="w-5 h-5 text-[#F59E0B]" />
                  )}
                  <span className={`text-2xl font-bold tracking-tight ${signalColor}`}>
                    {analysis.signal}
                  </span>
                  <span className="text-xs text-[#94A3B8] font-mono tabular-nums ml-1">
                    {analysis.confidence}% confidence
                  </span>
                </div>
                <p className="text-xs text-[#94A3B8] mt-1">
                  Bias {analysis.marketBias} · {analysis.setupPattern}
                </p>
              </div>

              <div className="text-right font-mono tabular-nums text-[11px] text-[#94A3B8]">
                <div>{new Date(analysis.timestamp).toLocaleTimeString('id-ID')}</div>
                <div className="inline-flex items-center gap-1 justify-end mt-0.5">
                  {analysis.usedChartVision && <Eye className="w-3 h-3 text-[#D4AF37]" />}
                  <span>{analysis.latencyMs} ms</span>
                </div>
                {analysis.model && (
                  <div className="text-[10px] text-[#64748B] mt-0.5 truncate max-w-[140px]">
                    {analysis.model}
                  </div>
                )}
              </div>
            </div>

            {/* Price Matrix */}
            <div className="grid grid-cols-2 gap-px bg-white/[0.08] border border-white/[0.08] rounded-md overflow-hidden font-mono tabular-nums text-xs">
              <div className="bg-[#0B0E14] p-2.5">
                <div className="text-[#94A3B8] text-[11px]">Entry Referensi</div>
                <div className="text-[#F8FAFC] font-semibold mt-0.5">
                  {analysis.entryPrice.toFixed(2)}
                </div>
              </div>
              <div className="bg-[#0B0E14] p-2.5">
                <div className="text-[#94A3B8] text-[11px]">Stop Loss</div>
                {isNoSlMode ? (
                  <div className="text-[#D4AF37] font-semibold mt-0.5 font-sans text-[11px]">
                    Tanpa SL (AI Exit)
                    <span className="block text-[10px] text-[#94A3B8] font-mono font-normal">
                      Ref: {analysis.stopLoss.toFixed(2)}
                    </span>
                  </div>
                ) : (
                  <div className="text-[#EF4444] font-semibold mt-0.5">
                    {analysis.stopLoss.toFixed(2)}
                  </div>
                )}
              </div>
              <div className="bg-[#0B0E14] p-2.5">
                <div className="text-[#94A3B8] text-[11px]">Take Profit 1</div>
                <div className="text-[#10B981] font-semibold mt-0.5">
                  {analysis.takeProfit1.toFixed(2)}
                </div>
              </div>
              <div className="bg-[#0B0E14] p-2.5">
                <div className="text-[#94A3B8] text-[11px]">TP2 / Risk:Reward</div>
                <div className="text-[#10B981] font-semibold mt-0.5">
                  {analysis.takeProfit2.toFixed(2)}{' '}
                  <span className="text-[#94A3B8] font-normal">({analysis.riskRewardRatio})</span>
                </div>
              </div>
            </div>

            {/* AI Exit Decision Status when evaluating open positions */}
            {analysis.positionDecision && analysis.positionDecision !== 'NONE' && (
              <div
                className={`p-2.5 rounded-md border space-y-1.5 text-xs ${
                  analysis.positionDecision === 'KEEP'
                    ? 'bg-[#10B981]/10 border-[#10B981]/30'
                    : 'bg-[#EF4444]/10 border-[#EF4444]/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[#F8FAFC]">Pantau Posisi (AI Exit Judge)</span>
                  <span
                    className={`font-mono font-bold text-[11px] px-1.5 py-0.5 rounded ${
                      analysis.positionDecision === 'KEEP'
                        ? 'bg-[#10B981]/20 text-[#10B981]'
                        : 'bg-[#EF4444]/20 text-[#EF4444]'
                    }`}
                  >
                    {analysis.positionDecision === 'KEEP'
                      ? 'KEEP (TP Aktif)'
                      : analysis.positionDecision}
                  </span>
                </div>
                {(analysis.winProbability !== undefined || analysis.reversalConfidence !== undefined) && (
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums">
                    {analysis.winProbability !== undefined && (
                      <span
                        className={`px-1.5 py-0.5 rounded border ${
                          analysis.winProbability < 20
                            ? 'bg-[#EF4444]/15 border-[#EF4444]/40 text-[#FCA5A5]'
                            : 'bg-[#0B0E14] border-white/[0.1] text-[#10B981]'
                        }`}
                      >
                        Peluang Win: {analysis.winProbability}% (&lt;20%)
                      </span>
                    )}
                    {analysis.reversalConfidence !== undefined && (
                      <span
                        className={`px-1.5 py-0.5 rounded border ${
                          analysis.reversalConfidence >= 80
                            ? 'bg-[#EF4444]/15 border-[#EF4444]/40 text-[#FCA5A5]'
                            : 'bg-[#0B0E14] border-white/[0.1] text-[#94A3B8]'
                        }`}
                      >
                        Balik Arah: {analysis.reversalConfidence}% (≥80%)
                      </span>
                    )}
                  </div>
                )}
                {analysis.positionReason && (
                  <p className="text-[11px] text-[#E6EDF3] leading-relaxed">
                    {analysis.positionReason}
                  </p>
                )}
                {openPositionsCount > 0 &&
                  analysis.highProbTp !== undefined &&
                  analysis.highProbTp > 0 && (
                    <div className="pt-1.5 border-t border-white/[0.08] flex items-center justify-between text-[11px] font-mono tabular-nums">
                      <span className="font-sans text-[#94A3B8]">
                        TP Gabungan (Prob ≥{analysis.highProbTpConfidence ?? 85}%):
                      </span>
                      <span className="font-semibold text-[#D4AF37]">
                        {analysis.highProbTp.toFixed(2)}
                      </span>
                    </div>
                  )}
              </div>
            )}

            {/* Post-TP Situational Continuation vs Exhaustion Evaluation */}
            {analysis.postTpEvaluation && analysis.postTpEvaluation !== 'NONE' && (
              <div
                className={`p-2.5 rounded-md border space-y-1 text-xs ${
                  analysis.postTpEvaluation === 'RE_ENTRY_CONTINUATION'
                    ? 'bg-[#10B981]/10 border-[#10B981]/30'
                    : analysis.postTpEvaluation === 'EXHAUSTION_SKIP'
                    ? 'bg-[#EF4444]/10 border-[#EF4444]/30'
                    : 'bg-[#F59E0B]/10 border-[#F59E0B]/30'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[#F8FAFC]">Analisa Pasca-TP</span>
                  <span
                    className={`font-mono font-bold text-[10px] px-1.5 py-0.5 rounded ${
                      analysis.postTpEvaluation === 'RE_ENTRY_CONTINUATION'
                        ? 'bg-[#10B981]/20 text-[#10B981]'
                        : analysis.postTpEvaluation === 'EXHAUSTION_SKIP'
                        ? 'bg-[#EF4444]/20 text-[#EF4444]'
                        : 'bg-[#F59E0B]/20 text-[#F59E0B]'
                    }`}
                  >
                    {analysis.postTpEvaluation === 'RE_ENTRY_CONTINUATION'
                      ? 'LANJUT ENTRY'
                      : analysis.postTpEvaluation === 'EXHAUSTION_SKIP'
                      ? 'JENUH · HOLD'
                      : 'TUNGGU PULLBACK'}
                  </span>
                </div>
                {analysis.postTpReason && (
                  <p className="text-[11px] text-[#E6EDF3] leading-relaxed">
                    {analysis.postTpReason}
                  </p>
                )}
              </div>
            )}

            {/* AI Judge Verdict + S/R Key Levels + Indicator Weighting */}
            {(analysis.judgeVerdict || analysis.keyLevelsSummary || analysis.indicatorWeighting) && (
              <div className="p-2.5 rounded-md bg-[#0B0E14] border border-[#D4AF37]/30 space-y-1.5 text-xs">
                {analysis.judgeVerdict && (
                  <div className="font-semibold text-[#F8FAFC] leading-snug">
                    {analysis.judgeVerdict}
                  </div>
                )}
                {analysis.keyLevelsSummary && (
                  <p className="text-[11px] text-[#E6EDF3] leading-relaxed">
                    <span className="text-[#2DD4BF] font-medium">Peta S/R &amp; Pola: </span>
                    {analysis.keyLevelsSummary}
                  </p>
                )}
                {analysis.indicatorWeighting && (
                  <p className="text-[11px] text-[#94A3B8] leading-relaxed">
                    <span className="text-[#D4AF37] font-medium">Timbangan Indikator: </span>
                    {analysis.indicatorWeighting}
                  </p>
                )}
              </div>
            )}

            {/* OCR, Global Sync, Macro DXY/Geopolitics, MTF M5-H4 & Lock Profit Plan */}
            {(analysis.ocrExtractedPrice ||
              analysis.globalSyncSummary ||
              analysis.macroSummary ||
              analysis.mtfSummary ||
              (analysis.lockProfitPlan && analysis.signal !== 'HOLD')) && (
              <div className="p-2.5 rounded-md bg-[#0B0E14] border border-white/[0.08] space-y-1.5 text-[11px]">
                {(analysis.ocrExtractedPrice || analysis.globalSyncSummary) && (
                  <p className="text-[#E6EDF3] leading-relaxed">
                    <span className="text-[#D4AF37] font-medium">OCR &amp; Sinkronisasi Global: </span>
                    {[analysis.ocrExtractedPrice, analysis.globalSyncSummary].filter(Boolean).join(' · ')}
                  </p>
                )}
                {analysis.macroSummary && (
                  <p className="text-[#E6EDF3] leading-relaxed">
                    <span className="text-[#38BDF8] font-medium">DXY, Makro &amp; Geopolitik: </span>
                    {analysis.macroSummary}
                  </p>
                )}
                {analysis.mtfSummary && (
                  <p className="text-[#E6EDF3] leading-relaxed">
                    <span className="text-[#A78BFA] font-medium">Lintas Timeframe (M5–H4): </span>
                    {analysis.mtfSummary}
                  </p>
                )}
                {analysis.lockProfitPlan && analysis.signal !== 'HOLD' && (
                  <div className="pt-1 border-t border-white/[0.06] flex items-center justify-between font-mono tabular-nums text-[#10B981]">
                    <span className="font-sans text-[#94A3B8]">Lock Profit Plan:</span>
                    <span>
                      25%: {analysis.lockProfitPlan.lock25Price.toFixed(2)} · 50%:{' '}
                      {analysis.lockProfitPlan.lock50Price.toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Summary & Technical Factors */}
            <div className="space-y-2.5 text-xs">
              <p className="text-[#E6EDF3] leading-relaxed">{analysis.summary}</p>
              {analysis.keyFactors.length > 0 && (
                <ul className="space-y-1.5 text-[#94A3B8] pt-1 border-t border-white/[0.06]">
                  {analysis.keyFactors.map((factor, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="text-[#D4AF37] font-mono">0{idx + 1}.</span>
                      <span className="leading-snug">{factor}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pt-2 border-t border-white/[0.06] text-[11px] text-[#94A3B8]">
                <span className="text-[#E6EDF3] font-medium">Invalidasi: </span>
                {analysis.invalidatedIf}
              </div>
              {analysis.dataSources && analysis.dataSources.length > 0 && (
                <div className="text-[10px] text-[#64748B] leading-relaxed">
                  <span className="text-[#94A3B8] font-medium">Sumber Data: </span>
                  {analysis.dataSources.join(' · ')}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Order Execution Footer + Live % Risk Preview */}
        <div className="pt-3 border-t border-white/[0.08] space-y-2.5">
          <div className="p-2.5 rounded bg-[#0B0E14] border border-white/[0.08] flex items-center justify-between text-[11px] font-mono tabular-nums">
            <div>
              <span className="text-[#94A3B8]">
                {isNoSlMode ? 'Proteksi: ' : 'Risk Order: '}
              </span>
              {isNoSlMode ? (
                <strong className="text-[#D4AF37] font-sans">Tanpa SL (AI Exit)</strong>
              ) : (
                <>
                  <strong
                    className={
                      previewRiskPct > 2.5
                        ? 'text-[#EF4444]'
                        : previewRiskPct > 1.5
                        ? 'text-[#F59E0B]'
                        : 'text-[#10B981]'
                    }
                  >
                    {previewRiskPct.toFixed(2)}%
                  </strong>
                  <span className="text-[#94A3B8] ml-1">(${previewRiskUsd.toFixed(2)})</span>
                </>
              )}
            </div>
            <div>
              <span className="text-[#94A3B8]">Aktif: </span>
              <strong
                className={
                  totalExposurePercent >= config.maxDailyLossPercent
                    ? 'text-[#EF4444]'
                    : totalExposurePercent >= 2.5
                    ? 'text-[#F59E0B]'
                    : 'text-[#E6EDF3]'
                }
              >
                {totalExposurePercent.toFixed(2)}%
              </strong>
              <span className="text-[#94A3B8] ml-1">(${totalExposureUsd.toFixed(2)})</span>
            </div>
          </div>

          {analysis && analysis.signal !== 'HOLD' && (
            <div className="space-y-1.5">
              {oppositePositions.length > 0 && (
                <p className="text-[11px] text-[#F59E0B] leading-snug">
                  Anti-Hedging aktif: masih ada posisi {oppositePositions[0].side} yang KEEP.
                </p>
              )}
              {isSameSideLayer && analysis.confidence < sameSideMinConf && (
                <p className="text-[11px] text-[#F59E0B] leading-snug">
                  Auto-Martil/Layer menunggu keyakinan ≥ {sameSideMinConf}% (saat ini{' '}
                  {analysis.confidence}%).
                </p>
              )}
              <button
                type="button"
                onClick={onExecuteAiSignal}
                disabled={!quote || oppositePositions.length > 0}
                className={`w-full py-2.5 px-4 text-xs font-semibold rounded-md transition-colors disabled:opacity-50 ${
                  analysis.signal === 'BUY'
                    ? 'bg-[#10B981] text-[#0B0E14] hover:bg-[#34D399]'
                    : 'bg-[#EF4444] text-white hover:bg-[#F87171]'
                }`}
              >
                {isSameSideLayer
                  ? `${isMartilLayer ? 'Martil' : 'Layer'} ${analysis.signal} ${suggestedLot.toFixed(
                      2
                    )} Lot · TP Keduanya ${effectiveTpDisplay.toFixed(2)} (≥${
                      analysis.highProbTpConfidence ?? 85
                    }%)`
                  : isNoSlMode
                  ? `Eksekusi ${analysis.signal} AI (${suggestedLot.toFixed(
                      2
                    )} Lot · Tanpa SL · TP ${analysis.takeProfit1.toFixed(2)})`
                  : `Eksekusi ${analysis.signal} AI (${suggestedLot.toFixed(
                      2
                    )} Lot · Risk ${previewRiskPct.toFixed(2)}%)`}
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onQuickMarketOrder('BUY')}
              disabled={!quote}
              className="py-2 px-3 text-xs font-semibold rounded-md border border-[#10B981]/40 bg-[#10B981]/10 text-[#10B981] hover:bg-[#10B981]/20 disabled:opacity-40 transition-colors font-mono tabular-nums"
            >
              Buy {quote ? quote.ask.toFixed(2) : '--'}
            </button>
            <button
              type="button"
              onClick={() => onQuickMarketOrder('SELL')}
              disabled={!quote}
              className="py-2 px-3 text-xs font-semibold rounded-md border border-[#EF4444]/40 bg-[#EF4444]/10 text-[#EF4444] hover:bg-[#EF4444]/20 disabled:opacity-40 transition-colors font-mono tabular-nums"
            >
              Sell {quote ? quote.bid.toFixed(2) : '--'}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
};
