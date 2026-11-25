import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar, type ActiveTab } from './components/TopBar.tsx';
import { MarketStrip } from './components/MarketStrip.tsx';
import {
  CandlestickChart,
  type CandlestickChartHandle,
} from './components/CandlestickChart.tsx';
import { EaSignalPanel } from './components/EaSignalPanel.tsx';
import { PositionsDrawer } from './components/PositionsDrawer.tsx';
import { EaSettingsView } from './components/EaSettingsView.tsx';
import { HistoryAnalyticsView } from './components/HistoryAnalyticsView.tsx';
import { BarChart3, CandlestickChart as CandlestickIcon, Cpu, SlidersHorizontal } from 'lucide-react';
import { Mql5BridgeView } from './components/Mql5BridgeView.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import { RiskToastStack } from './components/RiskToastStack.tsx';
import {
  TIMEFRAME_META,
  getTimeframeForCadence,
  type BrokerFeedId,
  type ClosedTrade,
  type EaAnalysisResult,
  type EaConfig,
  type MacroContext,
  type MarketSnapshot,
  type Mt5BridgeStatus,
  type OpenPosition,
  type RecentClosedTradeContext,
  type RiskNotification,
} from './types/trading.ts';
import { calculateXauLotSize, calculateXauPnl } from './utils/indicators.ts';

const STORAGE_KEYS = {
  CONFIG: 'aurumea_v1_config',
  BALANCE: 'aurumea_v1_balance',
  POSITIONS: 'aurumea_v1_positions',
  HISTORY: 'aurumea_v1_history',
  LOGS: 'aurumea_v1_logs',
};

const DEFAULT_CONFIG: EaConfig = {
  autoAnalyze: false,
  analyzeCadence: '30S',
  autoExecute: false,
  minConfidence: 76,
  lotMode: 'RISK_PERCENT',
  riskPercent: 1.0,
  fixedLot: 0.05,
  maxOpenPositions: 2,
  maxDailyLossPercent: 5.0,
  useTrailingStop: true,
  trailingAtrMultiplier: 0.9,
  useBreakeven: true,
  breakevenTriggerUsd: 1.2,
  noSlAiExit: true,
  fullAiControl: true,
  allowSameSideLayering: true,
  sameSideMinConfidence: 80,
  martingaleEnabled: true,
  martingaleMultiplier: 2.0,
  aiProvider: 'AUTO',
  aiThinkingHigh: true,
  strategyFocus: 'ADAPTIVE_SCALP',
  brokerFeed: 'PEPPERSTONE',
  initialBalance: 10000,
};

const INITIAL_MT5_STATUS: Mt5BridgeStatus = {
  configured: false,
  connected: false,
  profile: null,
  lastHeartbeatAt: null,
  liveAccount: null,
  pendingCommandsCount: 0,
};

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('terminal');
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);

  const [config, setConfig] = useState<EaConfig>(() => {
    const stored = readStoredJson<Partial<EaConfig>>(STORAGE_KEYS.CONFIG, DEFAULT_CONFIG);
    const validModes = new Set([
      'AUTO',
      'ROUND_ROBIN',
      'GEMINI',
      'AIRFORCE',
      'OPENROUTER',
      'OPENROUTER_RESPAN',
      'OPENROUTER_RESPAN_PPLX',
      'OPENROUTER_HEYGEN',
      'OPENROUTER_DREX',
      'OPENROUTER_JEV',
      'OPENROUTER_PPLX',
      'OPENROUTER_ARGON',
      'OPENROUTER_HYDROGEN',
      'OPENROUTER_NEMOTRON',
      'OPENROUTER_KIMI',
    ]);
    const normalizedProvider =
      stored.aiProvider && validModes.has(stored.aiProvider) ? stored.aiProvider : 'AUTO';
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      aiProvider: normalizedProvider,
    };
  });
  const [simBalance, setSimBalance] = useState<number>(() =>
    readStoredJson<number>(STORAGE_KEYS.BALANCE, DEFAULT_CONFIG.initialBalance)
  );
  const [simPositions, setSimPositions] = useState<OpenPosition[]>(() =>
    readStoredJson<OpenPosition[]>(STORAGE_KEYS.POSITIONS, [])
  );
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>(() =>
    readStoredJson<ClosedTrade[]>(STORAGE_KEYS.HISTORY, [])
  );
  const [analysisLogs, setAnalysisLogs] = useState<EaAnalysisResult[]>(() =>
    readStoredJson<EaAnalysisResult[]>(STORAGE_KEYS.LOGS, [])
  );

  const [mt5Status, setMt5Status] = useState<Mt5BridgeStatus>(INITIAL_MT5_STATUS);
  const [riskNotifications, setRiskNotifications] = useState<RiskNotification[]>([]);
  const [aiHealth, setAiHealth] = useState<{
    geminiKeySlots: number;
    keySlotNames: string[];
    hasAirforceKey: boolean;
    airforceModel: string;
    hasOpenRouterKey: boolean;
    openRouterModel: string;
  } | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [autoCountdownSec, setAutoCountdownSec] = useState<number | null>(null);
  const [macroContext, setMacroContext] = useState<MacroContext | null>(null);

  const chartRef = useRef<CandlestickChartHandle | null>(null);
  const lastAnalyzedCandleRef = useRef<number | null>(null);
  const isAnalyzingRef = useRef(false);
  const pausedByPositionRef = useRef(false);
  const mt5StatusRef = useRef(mt5Status);
  const configRef = useRef(config);
  const snapshotRef = useRef(snapshot);

  // Active balance & positions come from real MT5 account when connected, otherwise local sim
  const isMt5Live = Boolean(mt5Status.connected && mt5Status.liveAccount);
  const activeBalance = isMt5Live ? mt5Status.liveAccount!.balance : simBalance;

  const activePositions: OpenPosition[] = useMemo(() => {
    if (isMt5Live && mt5Status.liveAccount) {
      return mt5Status.liveAccount.positions.map((p) => ({
        id: `mt5_${p.ticket}`,
        mt5Ticket: p.ticket,
        side: p.side,
        lots: p.lots,
        entryPrice: p.openPrice,
        stopLoss: p.sl,
        takeProfit: p.tp,
        openedAt: p.openTime || Date.now(),
        source: 'MT5_LIVE',
        highestFavorablePrice: p.openPrice,
        trailingActivated: false,
      }));
    }
    return simPositions;
  }, [isMt5Live, mt5Status.liveAccount, simPositions]);

  const activePositionsRef = useRef(activePositions);
  const activeBalanceRef = useRef(activeBalance);
  const closedTradesRef = useRef(closedTrades);
  const prevMt5PositionsRef = useRef<OpenPosition[]>([]);
  activePositionsRef.current = activePositions;
  activeBalanceRef.current = activeBalance;
  closedTradesRef.current = closedTrades;
  mt5StatusRef.current = mt5Status;
  configRef.current = config;
  snapshotRef.current = snapshot;

  const pushRiskNotification = useCallback(
    (item: Omit<RiskNotification, 'id' | 'timestamp'>) => {
      const id = `risk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const entry: RiskNotification = { ...item, id, timestamp: Date.now() };
      setRiskNotifications((prev) => [entry, ...prev].slice(0, 4));
      setTimeout(() => {
        setRiskNotifications((prev) => prev.filter((n) => n.id !== id));
      }, 9000);
    },
    []
  );

  // Persist local simulation & config state
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(config));
  }, [config]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.BALANCE, JSON.stringify(simBalance));
  }, [simBalance]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.POSITIONS, JSON.stringify(simPositions));
  }, [simPositions]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(closedTrades));
  }, [closedTrades]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(analysisLogs.slice(0, 50)));
  }, [analysisLogs]);

  // Poll MT5 bridge status
  const refreshMt5Status = useCallback(async () => {
    try {
      const res = await fetch('/api/mt5/status');
      if (!res.ok) return;
      const data = (await res.json()) as Mt5BridgeStatus;
      setMt5Status(data);
    } catch {
      // Ignore transient poll error
    }
  }, []);

  useEffect(() => {
    void refreshMt5Status();
    const interval = setInterval(() => {
      void refreshMt5Status();
    }, 3000);
    return () => clearInterval(interval);
  }, [refreshMt5Status]);

  // Detect closed MT5 positions between polls so Post-TP context works seamlessly in MT5 Live mode
  useEffect(() => {
    if (!isMt5Live) {
      prevMt5PositionsRef.current = [];
      return;
    }
    const prevList = prevMt5PositionsRef.current;
    const currentIds = new Set(activePositions.map((p) => p.id));
    const disappeared = prevList.filter((p) => !currentIds.has(p.id));
    prevMt5PositionsRef.current = activePositions;

    if (disappeared.length === 0) return;
    const snap = snapshotRef.current;
    const now = Date.now();

    const inferred: ClosedTrade[] = disappeared.map((pos) => {
      const mark = snap
        ? pos.side === 'BUY'
          ? snap.quote.bid
          : snap.quote.ask
        : pos.entryPrice;
      const nearTp =
        pos.takeProfit > 0 &&
        (pos.side === 'BUY'
          ? mark >= pos.takeProfit - 0.6
          : mark <= pos.takeProfit + 0.6);
      const nearSl =
        pos.stopLoss > 0 &&
        (pos.side === 'BUY'
          ? mark <= pos.stopLoss + 0.6
          : mark >= pos.stopLoss - 0.6);
      const closePrice = nearTp ? pos.takeProfit : nearSl ? pos.stopLoss : mark;
      const closeReason: ClosedTrade['closeReason'] = nearTp
        ? 'TP Hit'
        : nearSl
        ? 'SL Hit'
        : 'MT5 Sync';
      const pnlUsd = calculateXauPnl(pos.side, pos.lots, pos.entryPrice, closePrice);
      const points =
        pos.side === 'BUY' ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
      return {
        id: `${pos.id}_closed_${now}`,
        side: pos.side,
        lots: pos.lots,
        entryPrice: pos.entryPrice,
        closePrice: Number(closePrice.toFixed(2)),
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        openedAt: pos.openedAt,
        closedAt: now,
        pnlUsd,
        points: Number(points.toFixed(2)),
        closeReason,
        source: 'MT5_LIVE',
        setupPattern: pos.setupPattern,
      };
    });

    setClosedTrades((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const fresh = inferred.filter((t) => !existingIds.has(t.id));
      return fresh.length > 0 ? [...fresh, ...prev] : prev;
    });
  }, [isMt5Live, activePositions]);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data === 'object') {
          setAiHealth({
            geminiKeySlots: Number(data.geminiKeySlots ?? 0),
            keySlotNames: Array.isArray(data.keySlotNames)
              ? data.keySlotNames.map(String)
              : [],
            hasAirforceKey: Boolean(data.hasAirforceKey),
            airforceModel: String(data.airforceModel || 'deepseek-v3'),
            hasOpenRouterKey: Boolean(data.hasOpenRouterKey),
            openRouterModel: String(
              data.openRouterModel || 'perplexity/pplx-decider-flash-v1.3:free'
            ),
          });
        }
      })
      .catch(() => {
        // Ignore transient health check error
      });
  }, [activeTab]);

  // Poll live Macro & DXY context every 60s
  useEffect(() => {
    let active = true;
    const loadMacro = async () => {
      try {
        const res = await fetch('/api/market/macro');
        if (!res.ok) return;
        const data = (await res.json()) as MacroContext;
        if (active && data) {
          setMacroContext(data);
        }
      } catch {
        // Ignore transient macro poll error
      }
    };
    void loadMacro();
    const interval = setInterval(() => {
      void loadMacro();
    }, 60_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const activeBrokerFeed: BrokerFeedId = config.brokerFeed ?? 'PEPPERSTONE';
  const activeTimeframe = getTimeframeForCadence(config.analyzeCadence);
  const activeTimeframeRef = useRef(activeTimeframe);
  activeTimeframeRef.current = activeTimeframe;

  // Fetch initial candles snapshot + open real-time SSE market stream for the selected broker & timeframe
  const connectStream = useCallback(() => {
    setLoadingFeed(true);
    setFeedError(null);
    setStreamConnected(false);

    const brokerParam = encodeURIComponent(activeBrokerFeed);
    const tfParam = encodeURIComponent(activeTimeframe);

    fetch(`/api/market/candles?broker=${brokerParam}&timeframe=${tfParam}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal memuat data pasar.');
        setSnapshot(data as MarketSnapshot);
        setLoadingFeed(false);
      })
      .catch((err: unknown) => {
        setFeedError(err instanceof Error ? err.message : 'Feed error');
        setLoadingFeed(false);
      });

    const es = new EventSource(`/api/market/stream?broker=${brokerParam}&timeframe=${tfParam}`);
    es.addEventListener('tick', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as MarketSnapshot;
        setSnapshot(parsed);
        setStreamConnected(true);
        setLoadingFeed(false);
        setFeedError(null);
      } catch {
        // Ignore malformed event
      }
    });
    es.addEventListener('feed_error', (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as { error?: string };
        setFeedError(parsed.error || 'Koneksi feed terganggu.');
      } catch {
        // Ignore
      }
      setStreamConnected(false);
    });
    es.onerror = () => {
      setStreamConnected(false);
    };

    return () => {
      es.close();
    };
  }, [activeBrokerFeed, activeTimeframe]);

  useEffect(() => {
    const cleanup = connectStream();
    return cleanup;
  }, [connectStream]);

  // Smooth 1-second candle countdown tick locally based on activeTimeframe
  useEffect(() => {
    const tfSeconds = TIMEFRAME_META[activeTimeframe].seconds;
    const timer = setInterval(() => {
      setSnapshot((prev) => {
        if (!prev) return prev;
        const nowSec = Math.floor(Date.now() / 1000);
        const boundary = Math.floor(nowSec / tfSeconds) * tfSeconds;
        const closeIn = Math.max(0, boundary + tfSeconds - nowSec);
        if (prev.quote.candleCloseInSec === closeIn) return prev;
        return {
          ...prev,
          quote: {
            ...prev.quote,
            candleCloseInSec: closeIn,
          },
        };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [activeTimeframe]);

  // Live Simulation Position Monitor (only runs for web sim positions; MT5 Live handles SL/TP on broker)
  useEffect(() => {
    if (isMt5Live || !snapshot || simPositions.length === 0) return;
    const { bid, ask } = snapshot.quote;
    const atr = snapshot.indicators.atr14 ?? 2.5;
    const cfg = configRef.current;

    const remaining: OpenPosition[] = [];
    const newlyClosed: ClosedTrade[] = [];
    let realizedDelta = 0;

    for (const pos of simPositions) {
      const exitPrice = pos.side === 'BUY' ? bid : ask;
      const isNoSlPos = pos.stopLoss <= 0 || (cfg.noSlAiExit ?? true);
      let hitReason: ClosedTrade['closeReason'] | null = null;
      let closePrice = exitPrice;

      if (pos.side === 'BUY') {
        if (!isNoSlPos && pos.stopLoss > 0 && exitPrice <= pos.stopLoss) {
          hitReason = pos.trailingActivated ? 'Trailing SL' : 'SL Hit';
          closePrice = pos.stopLoss;
        } else if (pos.takeProfit > 0 && exitPrice >= pos.takeProfit) {
          hitReason = 'TP Hit';
          closePrice = pos.takeProfit;
        }
      } else {
        if (!isNoSlPos && pos.stopLoss > 0 && exitPrice >= pos.stopLoss) {
          hitReason = pos.trailingActivated ? 'Trailing SL' : 'SL Hit';
          closePrice = pos.stopLoss;
        } else if (pos.takeProfit > 0 && exitPrice <= pos.takeProfit) {
          hitReason = 'TP Hit';
          closePrice = pos.takeProfit;
        }
      }

      if (hitReason) {
        const pnlUsd = calculateXauPnl(pos.side, pos.lots, pos.entryPrice, closePrice);
        const points =
          pos.side === 'BUY' ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
        realizedDelta += pnlUsd;
        newlyClosed.push({
          id: pos.id,
          side: pos.side,
          lots: pos.lots,
          entryPrice: pos.entryPrice,
          closePrice: Number(closePrice.toFixed(2)),
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          openedAt: pos.openedAt,
          closedAt: Date.now(),
          pnlUsd,
          points: Number(points.toFixed(2)),
          closeReason: hitReason,
          source: pos.source,
          setupPattern: pos.setupPattern,
        });
      } else if (isNoSlPos) {
        // Mode 100% Tanpa SL: jangan pasang/geser BE+ atau Trailing SL; biarkan AI Judge & TP bekerja
        remaining.push(pos);
      } else {
        let updatedPos = pos;
        const useBe = cfg.useBreakeven ?? true;
        const beTrig = cfg.breakevenTriggerUsd ?? 1.2;

        if (useBe) {
          if (pos.side === 'BUY') {
            const best = Math.max(pos.highestFavorablePrice, exitPrice);
            const beSl = Number((pos.entryPrice + 0.2).toFixed(2));
            if (best - pos.entryPrice >= beTrig && beSl > updatedPos.stopLoss && beSl < exitPrice) {
              updatedPos = {
                ...updatedPos,
                highestFavorablePrice: best,
                stopLoss: beSl,
                trailingActivated: true,
              };
            }
          } else {
            const best = Math.min(pos.highestFavorablePrice, exitPrice);
            const beSl = Number((pos.entryPrice - 0.2).toFixed(2));
            if (pos.entryPrice - best >= beTrig && beSl < updatedPos.stopLoss && beSl > exitPrice) {
              updatedPos = {
                ...updatedPos,
                highestFavorablePrice: best,
                stopLoss: beSl,
                trailingActivated: true,
              };
            }
          }
        }

        if (cfg.useTrailingStop) {
          const trailDist = atr * cfg.trailingAtrMultiplier;
          if (pos.side === 'BUY') {
            const best = Math.max(updatedPos.highestFavorablePrice, exitPrice);
            const candidateSl = Number((best - trailDist).toFixed(2));
            if (best - pos.entryPrice >= trailDist && candidateSl > updatedPos.stopLoss) {
              updatedPos = {
                ...updatedPos,
                highestFavorablePrice: best,
                stopLoss: candidateSl,
                trailingActivated: true,
              };
            } else if (best > updatedPos.highestFavorablePrice) {
              updatedPos = { ...updatedPos, highestFavorablePrice: best };
            }
          } else {
            const best = Math.min(updatedPos.highestFavorablePrice, exitPrice);
            const candidateSl = Number((best + trailDist).toFixed(2));
            if (pos.entryPrice - best >= trailDist && candidateSl < updatedPos.stopLoss) {
              updatedPos = {
                ...updatedPos,
                highestFavorablePrice: best,
                stopLoss: candidateSl,
                trailingActivated: true,
              };
            } else if (best < updatedPos.highestFavorablePrice) {
              updatedPos = { ...updatedPos, highestFavorablePrice: best };
            }
          }
        }
        remaining.push(updatedPos);
      }
    }

    if (newlyClosed.length > 0) {
      setSimPositions(remaining);
      setClosedTrades((prev) => [...newlyClosed, ...prev]);
      setSimBalance((prev) => Number((prev + realizedDelta).toFixed(2)));
    } else if (remaining.some((p, i) => p !== simPositions[i])) {
      setSimPositions(remaining);
    }
  }, [isMt5Live, snapshot, simPositions]);

  // Compute current active risk exposure across open positions
  const exposureMetrics = useMemo(() => {
    const usd = activePositions.reduce((acc, pos) => {
      const dist = pos.stopLoss > 0 ? Math.abs(pos.entryPrice - pos.stopLoss) : 0;
      return acc + dist * pos.lots * 100;
    }, 0);
    const pct = activeBalance > 0 ? (usd / activeBalance) * 100 : 0;
    return {
      usd: Number(usd.toFixed(2)),
      pct: Number(pct.toFixed(2)),
    };
  }, [activePositions, activeBalance]);

  const openOrder = useCallback(
    async (params: {
      side: 'BUY' | 'SELL';
      stopLoss: number;
      takeProfit: number;
      overrideTp?: number;
      source: OpenPosition['source'];
      confidence?: number;
      setupPattern?: string;
    }) => {
      const snap = snapshotRef.current;
      if (!snap) return;

      const cfg = configRef.current;
      const isNoSlMode = cfg.noSlAiExit ?? true;
      const curBalance = activeBalanceRef.current;
      const entry = params.side === 'BUY' ? snap.quote.ask : snap.quote.bid;
      const atr = snap.indicators.atr14 ?? 2.5;
      const refSl =
        params.stopLoss > 0
          ? Number(params.stopLoss.toFixed(2))
          : Number((params.side === 'BUY' ? entry - atr * 1.2 : entry + atr * 1.2).toFixed(2));
      const actualSl = isNoSlMode ? 0 : refSl;

      const sameSidePositions = activePositionsRef.current.filter((p) => p.side === params.side);
      const isLayering = sameSidePositions.length > 0;
      const isMartil = isLayering && (cfg.martingaleEnabled ?? true);

      const baseLot =
        cfg.lotMode === 'FIXED_LOT'
          ? cfg.fixedLot
          : calculateXauLotSize(curBalance, cfg.riskPercent, entry, refSl);

      let lots = baseLot;
      if (isMartil) {
        const latestSameSide = sameSidePositions.reduce(
          (latest, cur) => (cur.openedAt > latest.openedAt ? cur : latest),
          sameSidePositions[0]
        );
        const mult = Math.max(1.0, Math.min(5.0, cfg.martingaleMultiplier ?? 2.0));
        lots = Math.min(20, Math.max(0.01, Number((latestSameSide.lots * mult).toFixed(2))));
      }

      let finalTp = Number(
        (params.overrideTp && params.overrideTp > 0 ? params.overrideTp : params.takeProfit).toFixed(2)
      );

      if (isLayering) {
        const existingLots = sameSidePositions.reduce((s, p) => s + Math.max(0.01, p.lots), 0);
        const existingWeightedSum = sameSidePositions.reduce(
          (s, p) => s + p.entryPrice * Math.max(0.01, p.lots),
          0
        );
        const weightedAvg = (existingWeightedSum + entry * lots) / (existingLots + lots);

        if (params.side === 'BUY') {
          const minProfitAnchor = Number(Math.max(entry + 0.3, weightedAvg + 0.3).toFixed(2));
          const maxHighProbReach = Number((entry + Math.max(0.75, atr * 0.72)).toFixed(2));
          const cappedMax = Math.max(minProfitAnchor, maxHighProbReach);
          const seedTp =
            params.overrideTp && params.overrideTp > entry + 0.2
              ? params.overrideTp
              : Math.min(cappedMax, Math.max(minProfitAnchor, entry + atr * 0.5));
          finalTp = Number(Math.max(minProfitAnchor, Math.min(seedTp, cappedMax)).toFixed(2));
        } else {
          const maxProfitAnchor = Number(Math.min(entry - 0.3, weightedAvg - 0.3).toFixed(2));
          const minHighProbReach = Number((entry - Math.max(0.75, atr * 0.72)).toFixed(2));
          const cappedMin = Math.min(maxProfitAnchor, minHighProbReach);
          const seedTp =
            params.overrideTp && params.overrideTp < entry - 0.2
              ? params.overrideTp
              : Math.max(cappedMin, Math.min(maxProfitAnchor, entry - atr * 0.5));
          finalTp = Number(Math.min(maxProfitAnchor, Math.max(seedTp, cappedMin)).toFixed(2));
        }
      }

      const tradeRiskUsd =
        actualSl > 0 ? Number((Math.abs(entry - actualSl) * lots * 100).toFixed(2)) : 0;
      const tradeRiskPct =
        curBalance > 0 ? Number(((tradeRiskUsd / curBalance) * 100).toFixed(2)) : 0;
      const currentExposureUsd = activePositionsRef.current.reduce(
        (acc, p) => acc + (p.stopLoss > 0 ? Math.abs(p.entryPrice - p.stopLoss) * p.lots * 100 : 0),
        0
      );
      const nextTotalExposurePct =
        curBalance > 0
          ? Number((((currentExposureUsd + tradeRiskUsd) / curBalance) * 100).toFixed(2))
          : 0;

      const level: RiskNotification['level'] =
        nextTotalExposurePct >= cfg.maxDailyLossPercent
          ? 'CRITICAL'
          : tradeRiskPct > cfg.riskPercent * 1.35 || nextTotalExposurePct >= 3
          ? 'WARNING'
          : 'INFO';

      const liveMt5 = mt5StatusRef.current;
      if (liveMt5.connected) {
        try {
          const res = await fetch('/api/mt5/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: params.side,
              lots,
              sl: actualSl,
              tp: finalTp,
              refEntry: Number(entry.toFixed(2)),
              comment: isMartil
                ? `Martil ${params.setupPattern || 'AurumEA'}`.slice(0, 28)
                : params.setupPattern || 'AurumEA M5',
            }),
          });
          const data = (await res.json()) as { error?: string };
          if (!res.ok) {
            throw new Error(data.error || 'Gagal mengirim perintah order ke MT5.');
          }

          if (isLayering) {
            const modRes = await fetch('/api/mt5/order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'MODIFY_TP',
                side: params.side,
                tp: finalTp,
                ticket: 0,
                refEntry: Number(entry.toFixed(2)),
              }),
            });
            if (!modRes.ok) {
              const modData = (await modRes.json().catch(() => ({}))) as { error?: string };
              throw new Error(
                modData.error || 'Order terkirim, tetapi gagal menyamakan TP posisi sebelumnya di MT5.'
              );
            }
          }

          pushRiskNotification({
            level,
            title: isLayering
              ? `${isMartil ? 'Martil' : 'Layer'} MT5 (${params.side} ${lots.toFixed(2)} Lot · TP Keduanya ${finalTp.toFixed(2)})`
              : `Order Real MT5 Dikirim (${params.side} ${lots.toFixed(2)} Lot)`,
            message: isLayering
              ? `${params.side} baru @ ${entry.toFixed(2)} + sinkron TP gabungan ${finalTp.toFixed(2)} (Prob ≥85%) ke semua posisi ${params.side} MT5 #${liveMt5.profile?.login}.`
              : `Perintah ${params.side} XAU/USD @ ${entry.toFixed(2)} (${actualSl === 0 ? 'Tanpa SL · AI Exit' : `SL ${actualSl.toFixed(2)}`}, TP ${finalTp.toFixed(2)}) dikirim ke MT5 #${liveMt5.profile?.login}.`,
            tradeRiskPercent: tradeRiskPct,
            tradeRiskUsd,
            totalExposurePercent: nextTotalExposurePct,
          });
        } catch (err: unknown) {
          pushRiskNotification({
            level: 'CRITICAL',
            title: 'Eksekusi MT5 Gagal',
            message: err instanceof Error ? err.message : 'Gagal mengirim order ke MT5.',
            tradeRiskPercent: tradeRiskPct,
            tradeRiskUsd,
            totalExposurePercent: nextTotalExposurePct,
          });
        }
        return;
      }

      // Simulation mode execution
      const newPos: OpenPosition = {
        id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        side: params.side,
        lots,
        entryPrice: Number(entry.toFixed(2)),
        stopLoss: actualSl,
        takeProfit: finalTp,
        openedAt: Date.now(),
        source: params.source,
        confidence: params.confidence,
        setupPattern: isMartil
          ? `Martil: ${params.setupPattern || 'AI Layer'}`
          : params.setupPattern,
        highestFavorablePrice: Number(entry.toFixed(2)),
        trailingActivated: false,
      };

      setSimPositions((prev) => [
        newPos,
        ...prev.map((p) => (isLayering && p.side === params.side ? { ...p, takeProfit: finalTp } : p)),
      ]);

      pushRiskNotification({
        level,
        title: isLayering
          ? `${isMartil ? 'Martil' : 'Layer'} Simulasi (${params.side} ${lots.toFixed(2)} Lot)`
          : `Order Simulasi (${params.side} ${lots.toFixed(2)} Lot)`,
        message: isLayering
          ? `Posisi ${params.side} ke-${sameSidePositions.length + 1} @ ${entry.toFixed(2)}. TP semua posisi ${params.side} disamakan → ${finalTp.toFixed(2)} (Prob ≥85%).`
          : `Posisi ${params.side} XAU/USD @ ${entry.toFixed(2)} (${actualSl === 0 ? 'Tanpa SL · AI Exit aktif' : `SL ${actualSl.toFixed(2)}`} · TP ${finalTp.toFixed(2)}).`,
        tradeRiskPercent: tradeRiskPct,
        tradeRiskUsd,
        totalExposurePercent: nextTotalExposurePct,
      });
    },
    [pushRiskNotification]
  );

  // Close matching open positions automatically when AI Judge decides trend reversed / likely lose
  const closePositionsByAiDecision = useCallback(
    async (decision: 'CLOSE_BUY' | 'CLOSE_SELL' | 'CLOSE_ALL', reason: string) => {
      const snap = snapshotRef.current;
      const positions = activePositionsRef.current;
      const matches = positions.filter((p) =>
        decision === 'CLOSE_ALL'
          ? true
          : decision === 'CLOSE_BUY'
          ? p.side === 'BUY'
          : p.side === 'SELL'
      );
      if (matches.length === 0) return false;

      if (mt5StatusRef.current.connected) {
        try {
          if (decision === 'CLOSE_ALL') {
            await fetch('/api/mt5/order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'CLOSE_ALL' }),
            });
          } else {
            for (const p of matches) {
              if (p.mt5Ticket) {
                await fetch('/api/mt5/order', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: 'CLOSE',
                    ticket: p.mt5Ticket,
                    side: p.side,
                    comment: p.setupPattern || '',
                  }),
                });
              }
            }
          }
          pushRiskNotification({
            level: 'WARNING',
            title: `AI Exit MT5 (${decision})`,
            message: `${matches.length} posisi ditutup oleh AI Judge: ${reason}`,
            tradeRiskPercent: 0,
            tradeRiskUsd: 0,
            totalExposurePercent: 0,
          });
          return true;
        } catch {
          return false;
        }
      }

      if (!snap) return false;
      const targetIds = new Set(matches.map((m) => m.id));
      let closedCount = 0;
      let totalPnl = 0;

      setSimPositions((prev) => {
        const remaining: OpenPosition[] = [];
        const closedList: ClosedTrade[] = [];

        for (const pos of prev) {
          if (!targetIds.has(pos.id)) {
            remaining.push(pos);
            continue;
          }
          const closePrice = pos.side === 'BUY' ? snap.quote.bid : snap.quote.ask;
          const pnlUsd = calculateXauPnl(pos.side, pos.lots, pos.entryPrice, closePrice);
          const points =
            pos.side === 'BUY' ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
          totalPnl += pnlUsd;
          closedCount += 1;
          closedList.push({
            id: pos.id,
            side: pos.side,
            lots: pos.lots,
            entryPrice: pos.entryPrice,
            closePrice: Number(closePrice.toFixed(2)),
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            openedAt: pos.openedAt,
            closedAt: Date.now(),
            pnlUsd,
            points: Number(points.toFixed(2)),
            closeReason: 'AI Exit',
            source: pos.source,
            setupPattern: pos.setupPattern,
          });
        }

        if (closedList.length > 0) {
          setClosedTrades((hist) => [...closedList, ...hist]);
          setSimBalance((b) => Number((b + totalPnl).toFixed(2)));
        }
        return remaining;
      });

      if (closedCount > 0) {
        pushRiskNotification({
          level: 'WARNING',
          title: `AI Exit Menutup ${closedCount} Posisi (${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toFixed(2)})`,
          message: reason,
          tradeRiskPercent: 0,
          tradeRiskUsd: 0,
          totalExposurePercent: 0,
        });
        return true;
      }
      return false;
    },
    [pushRiskNotification]
  );

  // Run Gemini AI Chart Analysis
  const runGeminiAnalysis = useCallback(
    async (triggeredByAuto: boolean) => {
      if (isAnalyzingRef.current) return;
      const cfgBefore = configRef.current;
      const isNoSlBefore = cfgBefore.noSlAiExit ?? true;
      if (triggeredByAuto && activePositionsRef.current.length > 0 && !isNoSlBefore) return;
      isAnalyzingRef.current = true;
      setIsAnalyzing(true);
      setAnalysisError(null);

      try {
        const chartImageBase64 = chartRef.current?.captureChartImage() || undefined;
        const cfg = configRef.current;
        const isNoSlMode = cfg.noSlAiExit ?? true;
        const positions = activePositionsRef.current;
        const curBalance = activeBalanceRef.current;
        const snapNow = snapshotRef.current;

        const openSummary =
          positions.length === 0
            ? 'Tidak ada posisi aktif'
            : positions
                .map((p) => `${p.side} ${p.lots} lot @ ${p.entryPrice}`)
                .join(', ');

        const openPositionsDetail = positions.map((p) => {
          const mark = snapNow
            ? p.side === 'BUY'
              ? snapNow.quote.bid
              : snapNow.quote.ask
            : p.entryPrice;
          const floatingPnlUsd = calculateXauPnl(p.side, p.lots, p.entryPrice, mark);
          const openedMinutesAgo = Math.max(0, Math.round((Date.now() - p.openedAt) / 60000));
          return {
            id: p.id,
            side: p.side,
            lots: p.lots,
            entryPrice: p.entryPrice,
            takeProfit: p.takeProfit,
            floatingPnlUsd,
            openedMinutesAgo,
          };
        });

        const nowMs = Date.now();
        const recentClosedTrades: RecentClosedTradeContext[] = closedTradesRef.current
          .filter((t) => nowMs - t.closedAt <= 120 * 60_000)
          .slice(0, 5)
          .map((t) => ({
            side: t.side,
            entryPrice: t.entryPrice,
            closePrice: t.closePrice,
            takeProfit: t.takeProfit,
            pnlUsd: t.pnlUsd,
            points: t.points,
            closeReason: t.closeReason,
            closedMinutesAgo: Math.max(0, Math.round((nowMs - t.closedAt) / 60_000)),
          }));

        const requestBody = JSON.stringify({
          chartImageBase64,
          strategyFocus: cfg.strategyFocus,
          brokerFeed: cfg.brokerFeed ?? 'PEPPERSTONE',
          timeframe: activeTimeframeRef.current,
          riskPercent: cfg.riskPercent,
          accountBalance: curBalance,
          openPositionsCount: positions.length,
          openPositionsSummary: openSummary,
          openPositionsDetail,
          recentClosedTrades,
          noSlAiExit: isNoSlMode,
          fullAiControl: cfg.fullAiControl ?? true,
          aiProvider: cfg.aiProvider ?? 'AUTO',
          aiThinkingHigh: cfg.aiThinkingHigh ?? true,
        });

        let res!: Response;
        let rawBody = '';
        let data: {
          analysis?: EaAnalysisResult;
          snapshot?: MarketSnapshot;
          error?: string;
        } = {};

        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetch('/api/ea/analyze', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Aurum-Stream': '1',
            },
            body: requestBody,
          });
          rawBody = await res.text();
          data = {};
          if (!rawBody || !rawBody.trim()) break;
          try {
            data = JSON.parse(rawBody) as typeof data;
            break;
          } catch {
            if (attempt === 0) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
              continue;
            }
            throw new Error(
              `Server merespon non-JSON (HTTP ${res.status}). Kemungkinan server baru saja restart atau timeout gateway—silakan klik Analisa Chart lagi.`
            );
          }
        }

        if (!res.ok || data.error || !data.analysis) {
          throw new Error(data.error || `Gagal menjalankan analisa AI (HTTP ${res.status}).`);
        }

        if (data.snapshot) {
          setSnapshot(data.snapshot);
        }

        const analysis = data.analysis;
        lastAnalyzedCandleRef.current = analysis.candleTime;
        setAnalysisLogs((prev) => [analysis, ...prev].slice(0, 50));

        // Evaluasi AI Exit untuk posisi terbuka pada mode 100% Tanpa SL
        // Syarat ketat AI Exit Judge: peluang win < 20% DAN keyakinan harga berubah arah >= 80%
        let didCloseByAi = false;
        const meetsAiExitThreshold =
          (analysis.winProbability ?? 100) < 20 &&
          (analysis.reversalConfidence ?? 0) >= 80;
        if (
          positions.length > 0 &&
          isNoSlMode &&
          meetsAiExitThreshold &&
          (analysis.positionDecision === 'CLOSE_ALL' ||
            analysis.positionDecision === 'CLOSE_BUY' ||
            analysis.positionDecision === 'CLOSE_SELL')
        ) {
          didCloseByAi = await closePositionsByAiDecision(
            analysis.positionDecision,
            analysis.positionReason || analysis.judgeVerdict || analysis.summary
          );
        }

        // Notify user of calculated % risk when Gemini identifies an actionable setup
        if (analysis.signal !== 'HOLD' && !didCloseByAi) {
          const calcLots =
            cfg.lotMode === 'FIXED_LOT'
              ? cfg.fixedLot
              : calculateXauLotSize(
                  curBalance,
                  cfg.riskPercent,
                  analysis.entryPrice,
                  analysis.stopLoss
                );
          const signalRiskUsd = Number(
            (Math.abs(analysis.entryPrice - analysis.stopLoss) * calcLots * 100).toFixed(2)
          );
          const signalRiskPct =
            curBalance > 0 ? Number(((signalRiskUsd / curBalance) * 100).toFixed(2)) : 0;
          const activeRiskUsd = positions.reduce(
            (acc, p) =>
              acc + (p.stopLoss > 0 ? Math.abs(p.entryPrice - p.stopLoss) * p.lots * 100 : 0),
            0
          );
          const activeRiskPct =
            curBalance > 0 ? Number(((activeRiskUsd / curBalance) * 100).toFixed(2)) : 0;

          pushRiskNotification({
            level:
              !isNoSlMode && activeRiskPct + signalRiskPct >= cfg.maxDailyLossPercent
                ? 'WARNING'
                : 'INFO',
            title: `Sinyal Gemini ${analysis.signal} (${analysis.confidence}%)`,
            message: isNoSlMode
              ? `Setup ${analysis.setupPattern}. Rekomendasi ${calcLots.toFixed(2)} lot (Tanpa SL · AI Exit aktif, TP ${analysis.takeProfit1.toFixed(2)}).`
              : `Setup ${analysis.setupPattern}. Rekomendasi ${calcLots.toFixed(
                  2
                )} lot dengan risiko ${signalRiskPct.toFixed(2)}% ($${signalRiskUsd.toFixed(2)}).`,
            tradeRiskPercent: isNoSlMode ? 0 : signalRiskPct,
            tradeRiskUsd: isNoSlMode ? 0 : signalRiskUsd,
            totalExposurePercent: activeRiskPct,
          });
        }

        // Auto-Execution Guardrail Check (100% AI Judge authority for fresh entry; >=80% confidence for same-side layering/Martil)
        const isFullAi = cfg.fullAiControl ?? true;
        const hasOppositeOpenPosition = positions.some((p) => p.side !== analysis.signal);
        const hasSameSideOpen = positions.some((p) => p.side === analysis.signal);
        const sameSideAllowed =
          (cfg.allowSameSideLayering ?? true) &&
          analysis.confidence >= (cfg.sameSideMinConfidence ?? 80);
        const passesConfidence = hasSameSideOpen
          ? sameSideAllowed
          : isFullAi || analysis.confidence >= cfg.minConfidence;

        if (
          triggeredByAuto &&
          !didCloseByAi &&
          cfg.autoExecute &&
          analysis.signal !== 'HOLD' &&
          !hasOppositeOpenPosition &&
          passesConfidence &&
          positions.length < cfg.maxOpenPositions
        ) {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const dailyRealized = closedTrades
            .filter((t) => t.closedAt >= todayStart.getTime())
            .reduce((acc, t) => acc + t.pnlUsd, 0);
          const maxLossUsd = (cfg.initialBalance * cfg.maxDailyLossPercent) / 100;

          if (dailyRealized > -maxLossUsd) {
            await openOrder({
              side: analysis.signal,
              stopLoss: analysis.stopLoss,
              takeProfit: analysis.takeProfit1,
              overrideTp: hasSameSideOpen ? analysis.highProbTp : undefined,
              source: 'AI_AUTO',
              confidence: analysis.confidence,
              setupPattern: analysis.setupPattern,
            });
          }
        }
      } catch (err: unknown) {
        setAnalysisError(
          err instanceof Error ? err.message : 'Terjadi kesalahan saat memanggil endpoint Gemini.'
        );
      } finally {
        isAnalyzingRef.current = false;
        setIsAnalyzing(false);
      }
    },
    [closedTrades, closePositionsByAiDecision, openOrder, pushRiskNotification]
  );

  const hasOpenPositions = activePositions.length > 0;
  const isNoSlMode = config.noSlAiExit ?? true;

  // Auto-Analyze Scheduler:
  // - Jika ada posisi terbuka & Mode Tanpa SL aktif -> pantau otomatis sesuai interval timeframe chart (M5=5m, M15=15m, M30=30m, H1=60m)
  // - Jika ada posisi terbuka & Mode Tanpa SL nonaktif -> jeda otomatis untuk hemat token
  useEffect(() => {
    if (!config.autoAnalyze) {
      pausedByPositionRef.current = false;
      setAutoCountdownSec(null);
      return;
    }

    if (hasOpenPositions && !isNoSlMode) {
      pausedByPositionRef.current = true;
      setAutoCountdownSec(null);
      return;
    }

    if (hasOpenPositions && isNoSlMode) {
      pausedByPositionRef.current = false;
      const monitorSec = TIMEFRAME_META[activeTimeframe].seconds;
      let remaining = monitorSec;
      setAutoCountdownSec(remaining);

      const interval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          remaining = monitorSec;
          if (!isAnalyzingRef.current) {
            void runGeminiAnalysis(true);
          }
        }
        setAutoCountdownSec(remaining);
      }, 1000);

      return () => clearInterval(interval);
    }

    const resumedFromPosition = pausedByPositionRef.current;
    pausedByPositionRef.current = false;

    if (config.analyzeCadence === 'CANDLE_CLOSE') {
      if (resumedFromPosition && snapshotRef.current?.candles.length) {
        const latest = snapshotRef.current.candles[snapshotRef.current.candles.length - 1];
        lastAnalyzedCandleRef.current = latest.time;
      }

      const interval = setInterval(() => {
        if (activePositionsRef.current.length > 0) return;
        const snap = snapshotRef.current;
        if (!snap || snap.candles.length === 0) return;
        const latestCandleTime = snap.candles[snap.candles.length - 1].time;
        setAutoCountdownSec(snap.quote.candleCloseInSec);

        if (
          lastAnalyzedCandleRef.current !== null &&
          latestCandleTime > lastAnalyzedCandleRef.current &&
          !isAnalyzingRef.current
        ) {
          void runGeminiAnalysis(true);
        } else if (lastAnalyzedCandleRef.current === null && !isAnalyzingRef.current) {
          void runGeminiAnalysis(true);
        }
      }, 1000);
      return () => clearInterval(interval);
    }

    const cadenceSecMap: Record<Exclude<EaConfig['analyzeCadence'], 'CANDLE_CLOSE'>, number> = {
      '30S': 30,
      '60S': 60,
      '180S': 180,
      '900S': 900,
      '1800S': 1800,
      '3600S': 3600,
    };
    const cadenceSec = cadenceSecMap[config.analyzeCadence] ?? 30;
    const latestClosed = closedTradesRef.current[0];
    const justHitTp =
      latestClosed &&
      latestClosed.closeReason === 'TP Hit' &&
      Date.now() - latestClosed.closedAt < 20_000;
    let remaining = justHitTp ? 4 : resumedFromPosition ? cadenceSec : 3;
    setAutoCountdownSec(remaining);

    const interval = setInterval(() => {
      if (activePositionsRef.current.length > 0) return;
      remaining -= 1;
      if (remaining <= 0) {
        remaining = cadenceSec;
        if (!isAnalyzingRef.current) {
          void runGeminiAnalysis(true);
        }
      }
      setAutoCountdownSec(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [
    config.autoAnalyze,
    config.analyzeCadence,
    isNoSlMode,
    hasOpenPositions,
    activeTimeframe,
    runGeminiAnalysis,
  ]);

  const handleClosePosition = useCallback(async (id: string) => {
    const snap = snapshotRef.current;
    if (!snap) return;

    if (mt5StatusRef.current.connected && id.startsWith('mt5_')) {
      const ticket = Number(id.replace('mt5_', ''));
      const targetPos = activePositionsRef.current.find((p) => p.id === id);
      await fetch('/api/mt5/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'CLOSE',
          ticket,
          side: targetPos?.side,
          comment: targetPos?.setupPattern || '',
        }),
      });
      return;
    }

    setSimPositions((prev) => {
      const target = prev.find((p) => p.id === id);
      if (!target) return prev;
      const closePrice = target.side === 'BUY' ? snap.quote.bid : snap.quote.ask;
      const pnlUsd = calculateXauPnl(target.side, target.lots, target.entryPrice, closePrice);
      const points =
        target.side === 'BUY' ? closePrice - target.entryPrice : target.entryPrice - closePrice;

      const closed: ClosedTrade = {
        id: target.id,
        side: target.side,
        lots: target.lots,
        entryPrice: target.entryPrice,
        closePrice: Number(closePrice.toFixed(2)),
        stopLoss: target.stopLoss,
        takeProfit: target.takeProfit,
        openedAt: target.openedAt,
        closedAt: Date.now(),
        pnlUsd,
        points: Number(points.toFixed(2)),
        closeReason: 'Manual Close',
        source: target.source,
        setupPattern: target.setupPattern,
      };

      setClosedTrades((hist) => [closed, ...hist]);
      setSimBalance((b) => Number((b + pnlUsd).toFixed(2)));
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const handleCloseAll = useCallback(async () => {
    if (mt5StatusRef.current.connected) {
      await fetch('/api/mt5/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CLOSE_ALL' }),
      });
      return;
    }
    const ids = activePositionsRef.current.map((p) => p.id);
    for (const id of ids) {
      await handleClosePosition(id);
    }
  }, [handleClosePosition]);

  const handleQuickMarketOrder = useCallback(
    (side: 'BUY' | 'SELL') => {
      const snap = snapshotRef.current;
      if (!snap) return;
      const cfg = configRef.current;
      const isScalp =
        cfg.strategyFocus === 'ADAPTIVE_SCALP' ||
        cfg.strategyFocus === 'SCALPING_EMA' ||
        cfg.strategyFocus === 'ULTRA_SCALP';
      const atr = snap.indicators.atr14 ?? 2.5;
      const entry = side === 'BUY' ? snap.quote.ask : snap.quote.bid;
      const slDist = Number((atr * (isScalp ? 1.0 : 1.5)).toFixed(2));
      const tpDist = Number((atr * (isScalp ? 1.35 : 2.5)).toFixed(2));

      void openOrder({
        side,
        stopLoss: side === 'BUY' ? entry - slDist : entry + slDist,
        takeProfit: side === 'BUY' ? entry + tpDist : entry - tpDist,
        source: 'MARKET_MANUAL',
        setupPattern: isScalp ? 'Quick Scalp Market' : 'Market Order',
      });
    },
    [openOrder]
  );

  const latestAnalysis = analysisLogs[0] || null;

  const handleExecuteAiSignal = useCallback(() => {
    if (!latestAnalysis || latestAnalysis.signal === 'HOLD') return;
    const hasOpposite = activePositionsRef.current.some(
      (p) => p.side !== latestAnalysis.signal
    );
    if (hasOpposite) {
      pushRiskNotification({
        level: 'WARNING',
        title: 'Anti-Hedging Aktif',
        message: `Sinyal ${latestAnalysis.signal} ditahan karena masih ada posisi berlawanan arah yang KEEP.`,
        tradeRiskPercent: 0,
        tradeRiskUsd: 0,
        totalExposurePercent: 0,
      });
      return;
    }
    const hasSameSide = activePositionsRef.current.some(
      (p) => p.side === latestAnalysis.signal
    );
    void openOrder({
      side: latestAnalysis.signal,
      stopLoss: latestAnalysis.stopLoss,
      takeProfit: latestAnalysis.takeProfit1,
      overrideTp: hasSameSide ? latestAnalysis.highProbTp : undefined,
      source: 'AI_MANUAL',
      confidence: latestAnalysis.confidence,
      setupPattern: latestAnalysis.setupPattern,
    });
  }, [latestAnalysis, openOrder, pushRiskNotification]);

  const floatingPnl = useMemo(() => {
    if (isMt5Live && mt5Status.liveAccount) {
      const total = mt5Status.liveAccount.positions.reduce((acc, p) => acc + p.profit, 0);
      return Number(total.toFixed(2));
    }
    if (!snapshot || activePositions.length === 0) return 0;
    const total = activePositions.reduce((acc, pos) => {
      const mark = pos.side === 'BUY' ? snapshot.quote.bid : snapshot.quote.ask;
      return acc + calculateXauPnl(pos.side, pos.lots, pos.entryPrice, mark);
    }, 0);
    return Number(total.toFixed(2));
  }, [isMt5Live, mt5Status.liveAccount, snapshot, activePositions]);

  const equity =
    isMt5Live && mt5Status.liveAccount
      ? mt5Status.liveAccount.equity
      : Number((activeBalance + floatingPnl).toFixed(2));

  const handleResetAccount = () => {
    setSimPositions([]);
    setClosedTrades([]);
    setAnalysisLogs([]);
    setSimBalance(config.initialBalance);
  };

  const handleUpdateSimBalance = useCallback(
    (newBalance: number, syncInitial = false) => {
      if (!Number.isFinite(newBalance) || newBalance < 1) return;
      const clean = Number(newBalance.toFixed(2));
      setSimBalance(clean);
      if (syncInitial || closedTrades.length === 0) {
        setConfig((prev) => ({ ...prev, initialBalance: clean }));
      }
    },
    [closedTrades.length]
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0E14] text-[#E6EDF3]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onAnalyzeNow={() => void runGeminiAnalysis(false)}
        isAnalyzing={isAnalyzing}
      />

      <OfflineIndicator />

      <MarketStrip
        quote={snapshot?.quote ?? null}
        indicators={snapshot?.indicators ?? null}
        macroContext={macroContext}
        brokerFeed={activeBrokerFeed}
        timeframe={activeTimeframe}
        onChangeBrokerFeed={(broker) => {
          setSnapshot(null);
          setConfig((prev) => ({ ...prev, brokerFeed: broker }));
        }}
        balance={activeBalance}
        equity={equity}
        floatingPnl={floatingPnl}
        totalExposurePercent={exposureMetrics.pct}
        mt5Status={mt5Status}
        streamConnected={streamConnected}
        isMt5Live={isMt5Live}
        onUpdateSimBalance={(val) => handleUpdateSimBalance(val, false)}
      />

      <main className="flex-1 pb-20 md:pb-0">
        {activeTab === 'terminal' && (
          <div className="p-4 lg:p-5 space-y-4 max-w-[1600px] mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 items-stretch">
              <CandlestickChart
                ref={chartRef}
                snapshot={snapshot}
                brokerFeed={activeBrokerFeed}
                timeframe={activeTimeframe}
                latestAnalysis={latestAnalysis}
                openPositions={activePositions}
                noSlAiExit={isNoSlMode}
                loading={loadingFeed}
                error={feedError}
                onRetry={connectStream}
              />
              <EaSignalPanel
                analysis={latestAnalysis}
                quote={snapshot?.quote ?? null}
                config={config}
                timeframe={activeTimeframe}
                balance={activeBalance}
                atr14={snapshot?.indicators.atr14 ?? null}
                totalExposurePercent={exposureMetrics.pct}
                totalExposureUsd={exposureMetrics.usd}
                openPositionsCount={activePositions.length}
                openPositions={activePositions}
                mt5Status={mt5Status}
                isAnalyzing={isAnalyzing}
                analysisError={analysisError}
                autoCountdownSec={autoCountdownSec}
                onToggleAutoAnalyze={() =>
                  setConfig((prev) => ({ ...prev, autoAnalyze: !prev.autoAnalyze }))
                }
                onChangeAnalyzeCadence={(cadence) => {
                  const nextTf = getTimeframeForCadence(cadence);
                  if (nextTf !== activeTimeframe) {
                    setSnapshot(null);
                  }
                  setConfig((prev) => ({ ...prev, analyzeCadence: cadence }));
                }}
                onToggleAutoExecute={() =>
                  setConfig((prev) => ({ ...prev, autoExecute: !prev.autoExecute }))
                }
                onToggleFullAiControl={() =>
                  setConfig((prev) => ({
                    ...prev,
                    fullAiControl: !(prev.fullAiControl ?? true),
                  }))
                }
                onChangeAiProvider={(provider) =>
                  setConfig((prev) => ({ ...prev, aiProvider: provider }))
                }
                onAnalyzeNow={() => void runGeminiAnalysis(false)}
                onExecuteAiSignal={handleExecuteAiSignal}
                onQuickMarketOrder={handleQuickMarketOrder}
              />
            </div>

            <PositionsDrawer
              openPositions={activePositions}
              closedTrades={closedTrades}
              analysisLogs={analysisLogs}
              quote={snapshot?.quote ?? null}
              onClosePosition={(id) => void handleClosePosition(id)}
              onCloseAll={() => void handleCloseAll()}
            />
          </div>
        )}

        {activeTab === 'analytics' && (
          <HistoryAnalyticsView
            closedTrades={closedTrades}
            initialBalance={config.initialBalance}
            currentBalance={activeBalance}
          />
        )}

        {activeTab === 'settings' && (
          <EaSettingsView
            config={config}
            currentSimBalance={simBalance}
            isMt5Live={isMt5Live}
            aiHealth={aiHealth}
            onUpdateConfig={(patch) => {
              if (
                patch.analyzeCadence &&
                getTimeframeForCadence(patch.analyzeCadence) !== activeTimeframe
              ) {
                setSnapshot(null);
              }
              setConfig((prev) => ({ ...prev, ...patch }));
            }}
            onSetSimBalance={(val, syncInitial = true) =>
              handleUpdateSimBalance(val, syncInitial)
            }
            onResetAccount={handleResetAccount}
          />
        )}

        {activeTab === 'bridge' && (
          <Mql5BridgeView
            mt5Status={mt5Status}
            config={config}
            onRefreshStatus={refreshMt5Status}
          />
        )}
      </main>

      <RiskToastStack
        notifications={riskNotifications}
        onDismiss={(id) =>
          setRiskNotifications((prev) => prev.filter((item) => item.id !== id))
        }
      />

      {/* Sticky Android / Mobile Bottom Navigation Bar */}
      <nav
        aria-label="Navigasi seluler"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/[0.1] bg-[#0B0E14]/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-4 h-14">
          {(
            [
              { id: 'terminal', label: 'Terminal', Icon: CandlestickIcon },
              { id: 'analytics', label: 'Performa', Icon: BarChart3 },
              { id: 'settings', label: 'Parameter', Icon: SlidersHorizontal },
              { id: 'bridge', label: 'MT5', Icon: Cpu },
            ] as const
          ).map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                  isActive ? 'text-[#D4AF37]' : 'text-[#94A3B8] active:text-[#F8FAFC]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
