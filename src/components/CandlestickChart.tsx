import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  BROKER_FEEDS,
  TIMEFRAME_META,
  type BrokerFeedId,
  type ChartTimeframe,
  type EaAnalysisResult,
  type MarketSnapshot,
  type OpenPosition,
} from '../types/trading.ts';

export interface CandlestickChartHandle {
  captureChartImage: () => string | null;
}

interface CandlestickChartProps {
  snapshot: MarketSnapshot | null;
  brokerFeed: BrokerFeedId;
  timeframe: ChartTimeframe;
  latestAnalysis: EaAnalysisResult | null;
  openPositions: OpenPosition[];
  noSlAiExit?: boolean;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export const CandlestickChart = forwardRef<CandlestickChartHandle, CandlestickChartProps>(
  (
    {
      snapshot,
      brokerFeed,
      timeframe,
      latestAnalysis,
      openPositions,
      noSlAiExit = true,
      loading,
      error,
      onRetry,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const ema9SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const ema21SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
    const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
    const priceLinesRef = useRef<IPriceLine[]>([]);
    const hasFittedRef = useRef(false);
    const lastBrokerRef = useRef<string | undefined>(undefined);

    const [showEmas, setShowEmas] = useState(true);
    const [showBollinger, setShowBollinger] = useState(false);
    const [showSR, setShowSR] = useState(true);
    const [showAiLevels, setShowAiLevels] = useState(true);
    const [showTvWidget, setShowTvWidget] = useState(false);
    const [hoveredCandle, setHoveredCandle] = useState<{
      open: number;
      high: number;
      low: number;
      close: number;
    } | null>(null);

    useImperativeHandle(ref, () => ({
      captureChartImage: () => {
        if (!chartRef.current) return null;
        try {
          const canvas = chartRef.current.takeScreenshot(true, false);
          return canvas.toDataURL('image/png');
        } catch {
          return null;
        }
      },
    }));

    // Initialize chart once
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const chart = createChart(el, {
        layout: {
          background: { type: ColorType.Solid, color: '#0B0E14' },
          textColor: '#94A3B8',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
          horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: {
            color: 'rgba(212, 175, 55, 0.45)',
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: '#1E293B',
          },
          horzLine: {
            color: 'rgba(212, 175, 55, 0.45)',
            width: 1,
            style: LineStyle.Dashed,
            labelBackgroundColor: '#1E293B',
          },
        },
        rightPriceScale: {
          borderColor: 'rgba(255, 255, 255, 0.08)',
          scaleMargins: { top: 0.1, bottom: 0.12 },
        },
        timeScale: {
          borderColor: 'rgba(255, 255, 255, 0.08)',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 8,
          barSpacing: 9,
        },
        width: el.clientWidth,
        height: el.clientHeight || 460,
      });

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#10B981',
        downColor: '#EF4444',
        borderUpColor: '#10B981',
        borderDownColor: '#EF4444',
        wickUpColor: '#10B981',
        wickDownColor: '#EF4444',
      });

      const ema9 = chart.addSeries(LineSeries, {
        color: '#D4AF37',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const ema21 = chart.addSeries(LineSeries, {
        color: '#38BDF8',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const ema50 = chart.addSeries(LineSeries, {
        color: '#A78BFA',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });

      const bbUpper = chart.addSeries(LineSeries, {
        color: 'rgba(148, 163, 184, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const bbLower = chart.addSeries(LineSeries, {
        color: 'rgba(148, 163, 184, 0.45)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      });

      chart.subscribeCrosshairMove((param) => {
        if (!param.time) {
          setHoveredCandle(null);
          return;
        }
        const bar = param.seriesData.get(candleSeries) as
          | { open: number; high: number; low: number; close: number }
          | undefined;
        if (bar) {
          setHoveredCandle({
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
          });
        }
      });

      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
      ema9SeriesRef.current = ema9;
      ema21SeriesRef.current = ema21;
      ema50SeriesRef.current = ema50;
      bbUpperRef.current = bbUpper;
      bbLowerRef.current = bbLower;

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            chart.applyOptions({ width, height });
          }
        }
      });
      resizeObserver.observe(el);

      return () => {
        resizeObserver.disconnect();
        chart.remove();
        chartRef.current = null;
      };
    }, []);

    // Update series data when snapshot updates
    useEffect(() => {
      if (!snapshot || !candleSeriesRef.current) return;

      const candleData = snapshot.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      candleSeriesRef.current.setData(candleData);

      if (showEmas) {
        ema9SeriesRef.current?.setData(
          snapshot.ema9Series.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
        );
        ema21SeriesRef.current?.setData(
          snapshot.ema21Series.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
        );
        ema50SeriesRef.current?.setData(
          snapshot.ema50Series.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
        );
      } else {
        ema9SeriesRef.current?.setData([]);
        ema21SeriesRef.current?.setData([]);
        ema50SeriesRef.current?.setData([]);
      }

      if (showBollinger) {
        bbUpperRef.current?.setData(
          snapshot.bbUpperSeries.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
        );
        bbLowerRef.current?.setData(
          snapshot.bbLowerSeries.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
        );
      } else {
        bbUpperRef.current?.setData([]);
        bbLowerRef.current?.setData([]);
      }

      const feedKey = `${snapshot.quote.source}|${snapshot.quote.timeframe}`;
      if (lastBrokerRef.current !== feedKey) {
        lastBrokerRef.current = feedKey;
        hasFittedRef.current = false;
      }

      if (!hasFittedRef.current && candleData.length > 0) {
        const visibleCount = Math.min(85, candleData.length);
        chartRef.current?.timeScale().setVisibleLogicalRange({
          from: candleData.length - visibleCount,
          to: candleData.length + 6,
        });
        hasFittedRef.current = true;
      }
    }, [snapshot, showEmas, showBollinger]);

    // Update S/R, AI & Active Position horizontal price lines
    useEffect(() => {
      const series = candleSeriesRef.current;
      if (!series) return;

      for (const line of priceLinesRef.current) {
        series.removePriceLine(line);
      }
      priceLinesRef.current = [];

      if (snapshot?.quote) {
        priceLinesRef.current.push(
          series.createPriceLine({
            price: snapshot.quote.ask,
            color: 'rgba(245, 158, 11, 0.55)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'ASK',
          }),
          series.createPriceLine({
            price: snapshot.quote.bid,
            color: 'rgba(56, 189, 248, 0.55)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'BID',
          })
        );
      }

      const structure = snapshot?.indicators.structure;
      if (showSR && structure) {
        structure.resistances.slice(0, 2).forEach((r, idx) => {
          priceLinesRef.current.push(
            series.createPriceLine({
              price: r.price,
              color: idx === 0 ? 'rgba(244, 63, 94, 0.78)' : 'rgba(244, 63, 94, 0.42)',
              lineWidth: idx === 0 ? 1 : 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `R${idx + 1} (${r.touches}x)`,
            })
          );
        });
        structure.supports.slice(0, 2).forEach((s, idx) => {
          priceLinesRef.current.push(
            series.createPriceLine({
              price: s.price,
              color: idx === 0 ? 'rgba(45, 212, 191, 0.78)' : 'rgba(45, 212, 191, 0.42)',
              lineWidth: idx === 0 ? 1 : 1,
              lineStyle: LineStyle.Dashed,
              axisLabelVisible: true,
              title: `S${idx + 1} (${s.touches}x)`,
            })
          );
        });
      }

      if (showAiLevels && latestAnalysis && latestAnalysis.signal !== 'HOLD') {
        priceLinesRef.current.push(
          series.createPriceLine({
            price: latestAnalysis.entryPrice,
            color: '#D4AF37',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `AI ${latestAnalysis.signal}`,
          })
        );
        if (!noSlAiExit && latestAnalysis.stopLoss > 0) {
          priceLinesRef.current.push(
            series.createPriceLine({
              price: latestAnalysis.stopLoss,
              color: '#EF4444',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: 'AI SL',
            })
          );
        }
        if (latestAnalysis.takeProfit1 > 0) {
          priceLinesRef.current.push(
            series.createPriceLine({
              price: latestAnalysis.takeProfit1,
              color: '#10B981',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: 'AI TP1',
            })
          );
        }
      }

      openPositions.forEach((pos, idx) => {
        const labelIdx = openPositions.length > 1 ? ` #${idx + 1}` : '';
        priceLinesRef.current.push(
          series.createPriceLine({
            price: pos.entryPrice,
            color: pos.side === 'BUY' ? '#10B981' : '#EF4444',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `${pos.side}${labelIdx} (${pos.lots})`,
          })
        );
        if (pos.stopLoss > 0) {
          priceLinesRef.current.push(
            series.createPriceLine({
              price: pos.stopLoss,
              color: '#F87171',
              lineWidth: 1,
              lineStyle: LineStyle.LargeDashed,
              axisLabelVisible: true,
              title: `SL${labelIdx}`,
            })
          );
        }
        if (pos.takeProfit > 0) {
          priceLinesRef.current.push(
            series.createPriceLine({
              price: pos.takeProfit,
              color: '#34D399',
              lineWidth: 1,
              lineStyle: LineStyle.LargeDashed,
              axisLabelVisible: true,
              title: `TP${labelIdx}`,
            })
          );
        }
      });
    }, [snapshot, latestAnalysis, openPositions, showSR, showAiLevels, noSlAiExit]);

    const latestBar = snapshot?.candles[snapshot.candles.length - 1];
    const displayBar = hoveredCandle || latestBar;
    const activeBrokerMeta = BROKER_FEEDS.find((b) => b.id === brokerFeed);
    const tvSymbol = activeBrokerMeta?.tvSymbol || 'PEPPERSTONE:XAUUSD';
    const tvInterval = TIMEFRAME_META[timeframe].tvResolution;
    const tvWidgetUrl = `https://s3.tradingview.com/widgetembed/?frameElementId=tv_chart&symbol=${encodeURIComponent(
      tvSymbol
    )}&interval=${tvInterval}&hidesidetoolbar=0&symboledit=1&saveimage=0&toolbarbg=0B0E14&studies=[]&theme=dark&style=1&timezone=Etc%2FUTC&withdateranges=1&locale=id`;

    return (
      <div className="flex flex-col bg-[#0B0E14] border border-white/[0.08] rounded-lg overflow-hidden">
        {/* Chart Toolbar */}
        <div className="px-4 py-2.5 border-b border-white/[0.08] bg-[#111620] flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
            <span className="font-sans font-semibold text-[#F8FAFC]">
              Chart XAU/USD {timeframe}{' '}
              <span className="text-[#D4AF37] font-medium">
                · {activeBrokerMeta?.name || 'Pepperstone'}
              </span>
            </span>
            {displayBar && (
              <div className="flex items-center gap-3 text-[#94A3B8]">
                <span>
                  O <strong className="text-[#E6EDF3] font-medium">{displayBar.open.toFixed(2)}</strong>
                </span>
                <span>
                  H <strong className="text-[#E6EDF3] font-medium">{displayBar.high.toFixed(2)}</strong>
                </span>
                <span>
                  L <strong className="text-[#E6EDF3] font-medium">{displayBar.low.toFixed(2)}</strong>
                </span>
                <span>
                  C{' '}
                  <strong
                    className={`font-medium ${
                      displayBar.close >= displayBar.open ? 'text-[#10B981]' : 'text-[#EF4444]'
                    }`}
                  >
                    {displayBar.close.toFixed(2)}
                  </strong>
                </span>
              </div>
            )}
            {showEmas && snapshot && (
              <div className="hidden md:flex items-center gap-3 text-[11px]">
                <span className="text-[#D4AF37]">
                  EMA9 {snapshot.indicators.ema9?.toFixed(2) ?? '--'}
                </span>
                <span className="text-[#38BDF8]">
                  EMA21 {snapshot.indicators.ema21?.toFixed(2) ?? '--'}
                </span>
                <span className="text-[#A78BFA]">
                  EMA50 {snapshot.indicators.ema50?.toFixed(2) ?? '--'}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setShowTvWidget((v) => !v)}
              className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                showTvWidget
                  ? 'bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/60'
                  : 'bg-transparent text-[#94A3B8] border-white/[0.08] hover:text-[#E6EDF3]'
              }`}
              title="Tampilkan widget chart resmi TradingView untuk broker ini"
            >
              {showTvWidget ? 'TradingView Aktif' : 'Mode TradingView'}
            </button>
            <button
              type="button"
              onClick={() => setShowEmas((v) => !v)}
              className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                showEmas
                  ? 'bg-[#1E293B] text-[#F8FAFC] border-white/20'
                  : 'bg-transparent text-[#94A3B8] border-white/[0.08] hover:text-[#E6EDF3]'
              }`}
            >
              EMA 9/21/50
            </button>
            <button
              type="button"
              onClick={() => setShowBollinger((v) => !v)}
              className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                showBollinger
                  ? 'bg-[#1E293B] text-[#F8FAFC] border-white/20'
                  : 'bg-transparent text-[#94A3B8] border-white/[0.08] hover:text-[#E6EDF3]'
              }`}
            >
              Bollinger
            </button>
            <button
              type="button"
              onClick={() => setShowSR((v) => !v)}
              className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                showSR
                  ? 'bg-[#1E293B] text-[#2DD4BF] border-[#2DD4BF]/40'
                  : 'bg-transparent text-[#94A3B8] border-white/[0.08] hover:text-[#E6EDF3]'
              }`}
              title="Tampilkan garis Support & Resistance otomatis pada chart"
            >
              S/R &amp; Pola
            </button>
            <button
              type="button"
              onClick={() => setShowAiLevels((v) => !v)}
              className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                showAiLevels
                  ? 'bg-[#1E293B] text-[#D4AF37] border-[#D4AF37]/40'
                  : 'bg-transparent text-[#94A3B8] border-white/[0.08] hover:text-[#E6EDF3]'
              }`}
            >
              Level AI
            </button>
            <button
              type="button"
              onClick={() => {
                if (!snapshot?.candles.length || !chartRef.current) return;
                const len = snapshot.candles.length;
                chartRef.current.timeScale().setVisibleLogicalRange({
                  from: Math.max(0, len - 85),
                  to: len + 6,
                });
              }}
              className="px-2.5 py-1 text-xs font-medium rounded border border-white/[0.08] text-[#94A3B8] hover:text-[#E6EDF3] transition-colors whitespace-nowrap"
            >
              Reset Zoom
            </button>
          </div>
        </div>

        {/* Canvas Viewport */}
        <div className="relative w-full h-[340px] sm:h-[430px] lg:h-[500px] bg-[#0B0E14]">
          <div
            ref={containerRef}
            className={`w-full h-full ${showTvWidget ? 'opacity-0 pointer-events-none' : ''}`}
          />

          {showTvWidget && (
            <iframe
              key={`${tvSymbol}_${timeframe}`}
              title={`TradingView ${tvSymbol} ${timeframe}`}
              src={tvWidgetUrl}
              className="absolute inset-0 w-full h-full border-0 bg-[#0B0E14]"
              allowFullScreen
            />
          )}

          {loading && !snapshot && !showTvWidget && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0B0E14]/90">
              <div className="text-center space-y-2">
                <div className="w-6 h-6 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-xs text-[#94A3B8]">
                  Memuat candlestick {timeframe} XAU/USD real-time...
                </p>
              </div>
            </div>
          )}

          {error && !snapshot && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0B0E14]/95 p-6">
              <div className="max-w-sm text-center space-y-3">
                <p className="text-sm font-medium text-[#EF4444]">Koneksi Feed Pasar Terputus</p>
                <p className="text-xs text-[#94A3B8]">{error}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className="px-4 py-2 text-xs font-semibold rounded-md bg-[#1E293B] text-[#F8FAFC] hover:bg-[#334155] transition-colors"
                >
                  Coba Hubungkan Ulang
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Live S/R, Structure & Pattern Strip */}
        {snapshot?.indicators.structure && (
          <div className="px-4 py-2 border-t border-white/[0.08] bg-[#111620] flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-sans text-[#94A3B8]">
                Struktur:{' '}
                <strong className="text-[#F8FAFC] font-medium">
                  {snapshot.indicators.structure.marketStructure.replace(/_/g, ' ')}
                </strong>
              </span>
              {snapshot.indicators.structure.nearestSupport && (
                <span className="text-[#2DD4BF]">
                  S1 {snapshot.indicators.structure.nearestSupport.price.toFixed(2)}{' '}
                  <span className="text-[#64748B]">
                    (-{snapshot.indicators.structure.nearestSupport.distanceUsd.toFixed(2)})
                  </span>
                </span>
              )}
              {snapshot.indicators.structure.nearestResistance && (
                <span className="text-[#FB7185]">
                  R1 {snapshot.indicators.structure.nearestResistance.price.toFixed(2)}{' '}
                  <span className="text-[#64748B]">
                    (+{snapshot.indicators.structure.nearestResistance.distanceUsd.toFixed(2)})
                  </span>
                </span>
              )}
            </div>
            <div className="font-sans text-[#94A3B8] truncate max-w-full">
              {snapshot.indicators.structure.chartPatterns[0] ||
                snapshot.indicators.structure.candlestickPatterns[0] ||
                snapshot.indicators.structure.structureSummary}
            </div>
          </div>
        )}
      </div>
    );
  }
);

CandlestickChart.displayName = 'CandlestickChart';
