export interface Candle {
  time: number; // Unix timestamp in seconds (aligned to 5m boundary)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SupportResistanceLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strength: 'STRONG' | 'MODERATE' | 'MINOR';
  touches: number;
  distanceUsd: number;
  distanceAtr: number;
  label: string;
}

export interface ChartStructureAnalysis {
  marketStructure: 'UPTREND_HH_HL' | 'DOWNTREND_LH_LL' | 'CONSOLIDATION' | 'TRANSITION_BOS';
  structureSummary: string;
  nearestResistance: SupportResistanceLevel | null;
  nearestSupport: SupportResistanceLevel | null;
  resistances: SupportResistanceLevel[];
  supports: SupportResistanceLevel[];
  pivotPoint: number | null;
  sessionHigh: number;
  sessionLow: number;
  roundLevels: number[];
  candlestickPatterns: string[];
  chartPatterns: string[];
  fvgZones: Array<{ type: 'BULLISH_FVG' | 'BEARISH_FVG'; low: number; high: number }>;
  pricePositionNote: string;
}

export interface IndicatorSnapshot {
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  stochastic?: {
    k: number | null;
    d: number | null;
  };
  adx14?: number | null;
  obvTrend?: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  fibonacci?: {
    swingHigh: number;
    swingLow: number;
    trend: 'UP' | 'DOWN';
    r382: number;
    r500: number;
    r618: number;
    r786: number;
    ext1272: number;
    ext1618: number;
  };
  macd: {
    line: number | null;
    signal: number | null;
    histogram: number | null;
  };
  atr14: number | null;
  bollinger: {
    upper: number | null;
    middle: number | null;
    lower: number | null;
  };
  swingHigh: number;
  swingLow: number;
  structure?: ChartStructureAnalysis;
}

export interface MacroContext {
  dxyPrice: number | null;
  dxyChangePct: number | null;
  dxyBias: 'MENGUAT' | 'MELEMAH' | 'NETRAL';
  us10yYield: number | null;
  us10yChangePct: number | null;
  sp500Price: number | null;
  sp500ChangePct: number | null;
  headlines: Array<{ title: string; source: string; pubDate: string }>;
  updatedAt: number;
}

export type BrokerFeedId =
  | 'PEPPERSTONE'
  | 'TICKMILL'
  | 'ICMARKETS'
  | 'OANDA'
  | 'EIGHTCAP'
  | 'BLACKBULL'
  | 'FXCM'
  | 'MT5_LIVE'
  | 'AUTO_SPOT';

export interface BrokerFeedOption {
  id: BrokerFeedId;
  name: string;
  tvSymbol: string | null;
  description: string;
}

export const BROKER_FEEDS: BrokerFeedOption[] = [
  {
    id: 'PEPPERSTONE',
    name: 'Pepperstone',
    tvSymbol: 'PEPPERSTONE:XAUUSD',
    description: 'Pepperstone XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'TICKMILL',
    name: 'Tickmill',
    tvSymbol: 'TICKMILL:XAUUSD',
    description: 'Tickmill XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'ICMARKETS',
    name: 'IC Markets',
    tvSymbol: 'ICMARKETS:XAUUSD',
    description: 'IC Markets XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'OANDA',
    name: 'OANDA',
    tvSymbol: 'OANDA:XAUUSD',
    description: 'OANDA XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'EIGHTCAP',
    name: 'Eightcap',
    tvSymbol: 'EIGHTCAP:XAUUSD',
    description: 'Eightcap XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'BLACKBULL',
    name: 'BlackBull',
    tvSymbol: 'BLACKBULL:XAUUSD',
    description: 'BlackBull Markets XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'FXCM',
    name: 'FXCM',
    tvSymbol: 'FX:XAUUSD',
    description: 'FXCM (FX) XAUUSD Real-Time (TradingView Feed)',
  },
  {
    id: 'MT5_LIVE',
    name: 'MT5 Live Bridge',
    tvSymbol: null,
    description: 'Feed harga langsung dari Terminal MetaTrader 5 Anda',
  },
  {
    id: 'AUTO_SPOT',
    name: 'Auto Spot / PAXG',
    tvSymbol: null,
    description: 'Yahoo Finance Spot XAU/USD & Binance PAXG 24/7',
  },
];

export type ChartTimeframe = 'M5' | 'M15' | 'M30' | 'H1';

export interface TimeframeMeta {
  id: ChartTimeframe;
  label: string;
  seconds: number;
  tvResolution: '5' | '15' | '30' | '60';
  binanceInterval: '5m' | '15m' | '30m' | '1h';
  yahooInterval: '5m' | '15m' | '30m' | '60m';
  krakenInterval: 5 | 15 | 30 | 60;
}

export const TIMEFRAME_META: Record<ChartTimeframe, TimeframeMeta> = {
  M5: {
    id: 'M5',
    label: 'M5',
    seconds: 300,
    tvResolution: '5',
    binanceInterval: '5m',
    yahooInterval: '5m',
    krakenInterval: 5,
  },
  M15: {
    id: 'M15',
    label: 'M15',
    seconds: 900,
    tvResolution: '15',
    binanceInterval: '15m',
    yahooInterval: '15m',
    krakenInterval: 15,
  },
  M30: {
    id: 'M30',
    label: 'M30',
    seconds: 1800,
    tvResolution: '30',
    binanceInterval: '30m',
    yahooInterval: '30m',
    krakenInterval: 30,
  },
  H1: {
    id: 'H1',
    label: 'H1',
    seconds: 3600,
    tvResolution: '60',
    binanceInterval: '1h',
    yahooInterval: '60m',
    krakenInterval: 60,
  },
};

export function getTimeframeForCadence(cadence: EaConfig['analyzeCadence']): ChartTimeframe {
  if (cadence === '900S') return 'M15';
  if (cadence === '1800S') return 'M30';
  if (cadence === '3600S') return 'H1';
  return 'M5';
}

export interface MarketQuote {
  symbol: string;
  timeframe: ChartTimeframe;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  source: string;
  brokerId?: BrokerFeedId;
  brokerSymbol?: string;
  marketStatus: 'LIVE' | 'DELAYED';
  updatedAt: number;
  candleCloseInSec: number;
}

export interface MarketSnapshot {
  quote: MarketQuote;
  candles: Candle[];
  indicators: IndicatorSnapshot;
  ema9Series: Array<{ time: number; value: number }>;
  ema21Series: Array<{ time: number; value: number }>;
  ema50Series: Array<{ time: number; value: number }>;
  bbUpperSeries: Array<{ time: number; value: number }>;
  bbLowerSeries: Array<{ time: number; value: number }>;
}

export type TradeSignalType = 'BUY' | 'SELL' | 'HOLD';
export type MarketBias = 'BULLISH' | 'BEARISH' | 'RANGING';
export type PositionDecision = 'NONE' | 'KEEP' | 'CLOSE_BUY' | 'CLOSE_SELL' | 'CLOSE_ALL';
export type PostTpDecision =
  | 'NONE'
  | 'RE_ENTRY_CONTINUATION'
  | 'WAIT_PULLBACK_HOLD'
  | 'EXHAUSTION_SKIP';

export interface RecentClosedTradeContext {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  closePrice: number;
  takeProfit: number;
  pnlUsd: number;
  points: number;
  closeReason: ClosedTrade['closeReason'];
  closedMinutesAgo: number;
}

export interface EaAnalysisResult {
  id: string;
  timestamp: number;
  candleTime: number;
  priceAtAnalysis: number;
  signal: TradeSignalType;
  confidence: number;
  marketBias: MarketBias;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: string;
  setupPattern: string;
  summary: string;
  keyFactors: string[];
  invalidatedIf: string;
  model: string;
  latencyMs: number;
  usedChartVision: boolean;
  judgeVerdict?: string;
  indicatorWeighting?: string;
  authorityMode?: 'AI_JUDGE_100' | 'CONFIDENCE_FILTER';
  positionDecision?: PositionDecision;
  positionReason?: string;
  winProbability?: number;
  reversalConfidence?: number;
  highProbTp?: number;
  highProbTpConfidence?: number;
  postTpEvaluation?: PostTpDecision;
  postTpReason?: string;
  keyLevelsSummary?: string;
  ocrExtractedPrice?: string;
  globalSyncSummary?: string;
  macroSummary?: string;
  mtfSummary?: string;
  lockProfitPlan?: {
    lock25Price: number;
    lock50Price: number;
  };
  dataSources?: string[];
}

export interface OpenPosition {
  id: string;
  side: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  source: 'AI_AUTO' | 'AI_MANUAL' | 'MARKET_MANUAL' | 'MT5_LIVE';
  confidence?: number;
  setupPattern?: string;
  highestFavorablePrice: number;
  trailingActivated: boolean;
  mt5Ticket?: number;
}

export interface ClosedTrade {
  id: string;
  side: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  closePrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  closedAt: number;
  pnlUsd: number;
  points: number;
  closeReason: 'TP Hit' | 'SL Hit' | 'Trailing SL' | 'AI Exit' | 'Manual Close' | 'MT5 Sync';
  source: 'AI_AUTO' | 'AI_MANUAL' | 'MARKET_MANUAL' | 'MT5_LIVE';
  setupPattern?: string;
}

export type AiProviderMode =
  | 'AUTO'
  | 'ROUND_ROBIN'
  | 'OPENROUTER_RESPAN_PPLX'
  | 'GEMINI'
  | 'AIRFORCE'
  | 'OPENROUTER'
  | 'OPENROUTER_RESPAN'
  | 'OPENROUTER_HEYGEN'
  | 'OPENROUTER_DREX'
  | 'OPENROUTER_JEV'
  | 'OPENROUTER_PPLX'
  | 'OPENROUTER_ARGON'
  | 'OPENROUTER_HYDROGEN'
  | 'OPENROUTER_NEMOTRON'
  | 'OPENROUTER_KIMI';

export const AI_PROVIDER_OPTIONS: Array<{
  id: AiProviderMode;
  shortLabel: string;
  label: string;
}> = [
  {
    id: 'AUTO',
    shortLabel: 'Otomatis (Failover Kuota)',
    label: 'Otomatis Failover (Gemini 4 → Airforce → OpenRouter Pool)',
  },
  {
    id: 'ROUND_ROBIN',
    shortLabel: 'Bergantian (Round-Robin)',
    label: 'Bergantian Merata (Gemini 4 ↔ Airforce ↔ OpenRouter Pool)',
  },
  {
    id: 'OPENROUTER_RESPAN_PPLX',
    shortLabel: 'OR Dual (Span-01 ↔ PPLX)',
    label: 'OR Bergantian Cepat: Span-01-Lite ↔ PPLX-Decider (Auto-Takeover jika lambat)',
  },
  {
    id: 'GEMINI',
    shortLabel: 'Gemini 4 (Hydrogen / Argon)',
    label: 'Hanya Gemini 4 Direct (gemini-4-hydrogen → gemini-4-argon)',
  },
  {
    id: 'OPENROUTER',
    shortLabel: 'OpenRouter (All Pool)',
    label: 'OpenRouter Pool (Span-01 / PPLX / Heygen / Drex-Max / Jev-1.14 / Argon / Hydrogen / Nemotron / Kimi)',
  },
  {
    id: 'OPENROUTER_RESPAN',
    shortLabel: 'OR (span-01-lite:free)',
    label: 'OpenRouter Alpha Decisions: respan/span-01-lite:free',
  },
  {
    id: 'OPENROUTER_PPLX',
    shortLabel: 'OR (pplx-decider-flash)',
    label: 'OpenRouter Alpha Decisions: perplexity/pplx-decider-flash-v1.3:free',
  },
  {
    id: 'OPENROUTER_HEYGEN',
    shortLabel: 'OR (heygen-decision-1-turbo)',
    label: 'OpenRouter Alpha Decisions: heygen/heygen-decision-1-turbo',
  },
  {
    id: 'OPENROUTER_DREX',
    shortLabel: 'OR (nace-ai/drex-max)',
    label: 'OpenRouter Alpha Decisions: nace-ai/drex-max',
  },
  {
    id: 'OPENROUTER_JEV',
    shortLabel: 'OR (typesafe/jev-1.14)',
    label: 'OpenRouter Alpha Decisions: typesafe/jev-1.14',
  },
  {
    id: 'OPENROUTER_ARGON',
    shortLabel: 'OR (gemini-4-argon)',
    label: 'OpenRouter Chat: google/gemini-4-argon',
  },
  {
    id: 'OPENROUTER_HYDROGEN',
    shortLabel: 'OR (gemini-4-hydrogen)',
    label: 'OpenRouter Chat: google/gemini-4-hydrogen',
  },
  {
    id: 'OPENROUTER_NEMOTRON',
    shortLabel: 'OR (nemotron-3-ultra)',
    label: 'OpenRouter Chat: nvidia/nemotron-3-ultra-550b-a55b:free',
  },
  {
    id: 'OPENROUTER_KIMI',
    shortLabel: 'OR (kimi-k3.1-pro)',
    label: 'OpenRouter Chat: moonshotai/kimi-k3.1-pro',
  },
  {
    id: 'AIRFORCE',
    shortLabel: 'Airforce (deepseek-v3)',
    label: 'Hanya Airforce API (deepseek-v3)',
  },
];

export interface EaConfig {
  autoAnalyze: boolean;
  analyzeCadence: 'CANDLE_CLOSE' | '30S' | '60S' | '180S' | '900S' | '1800S' | '3600S';
  autoExecute: boolean;
  minConfidence: number;
  lotMode: 'RISK_PERCENT' | 'FIXED_LOT';
  riskPercent: number;
  fixedLot: number;
  maxOpenPositions: number;
  maxDailyLossPercent: number;
  useTrailingStop: boolean;
  trailingAtrMultiplier: number;
  useBreakeven?: boolean;
  breakevenTriggerUsd?: number;
  noSlAiExit?: boolean;
  fullAiControl?: boolean;
  allowSameSideLayering?: boolean;
  sameSideMinConfidence?: number;
  martingaleEnabled?: boolean;
  martingaleMultiplier?: number;
  aiProvider?: AiProviderMode;
  aiThinkingHigh?: boolean;
  strategyFocus: 'ADAPTIVE_SCALP' | 'BALANCED' | 'SCALPING_EMA' | 'ULTRA_SCALP' | 'LIQUIDITY_SMC';
  brokerFeed?: BrokerFeedId;
  initialBalance: number;
}

export interface Mt5AccountConfig {
  login: string;
  server: string;
  accountType: 'REAL' | 'DEMO';
  bridgeKey: string;
  configuredAt: number;
}

export interface Mt5LivePosition {
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  lots: number;
  openPrice: number;
  sl: number;
  tp: number;
  profit: number;
  openTime: number;
}

export interface Mt5ConnectedTerminal {
  terminalId: string;
  login: string;
  server: string;
  company: string;
  currency: string;
  balance: number;
  equity: number;
  positionsCount: number;
  isPrimary: boolean;
  lastSeenAt: number;
}

export interface Mt5BridgeStatus {
  configured: boolean;
  connected: boolean;
  profile: Mt5AccountConfig | null;
  lastHeartbeatAt: number | null;
  liveAccount: {
    login: string;
    server: string;
    company: string;
    currency: string;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    leverage: number;
    tradeAllowed: boolean;
    positions: Mt5LivePosition[];
  } | null;
  pendingCommandsCount: number;
  connectedTerminals?: Mt5ConnectedTerminal[];
}

export interface RiskNotification {
  id: string;
  timestamp: number;
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  tradeRiskPercent: number;
  tradeRiskUsd: number;
  totalExposurePercent: number;
}
