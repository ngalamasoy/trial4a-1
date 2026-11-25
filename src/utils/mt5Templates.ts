import type { AiProviderMode, EaConfig } from '../types/trading.ts';

export type Mt5ExecutionMode = 'COPY_WEB_ONLY' | 'HYBRID_AI_AND_WEB' | 'STANDALONE_AI';

export interface BridgeFileAsset {
  id: 'mq5' | 'cpp' | 'header' | 'def' | 'bat';
  filename: string;
  label: string;
  targetFolder: string;
  content: string;
}

function mapAiProviderEnum(provider?: AiProviderMode): string {
  switch (provider) {
    case 'ROUND_ROBIN':
      return 'AI_ROUND_ROBIN';
    case 'GEMINI':
      return 'AI_GEMINI';
    case 'OPENROUTER':
      return 'AI_OPENROUTER';
    case 'OPENROUTER_HEYGEN':
      return 'AI_OPENROUTER_HEYGEN';
    case 'OPENROUTER_DREX':
      return 'AI_OPENROUTER_DREX';
    case 'OPENROUTER_JEV':
      return 'AI_OPENROUTER_JEV';
    case 'OPENROUTER_PPLX':
      return 'AI_OPENROUTER_PPLX';
    case 'OPENROUTER_ARGON':
      return 'AI_OPENROUTER_ARGON';
    case 'OPENROUTER_HYDROGEN':
      return 'AI_OPENROUTER_HYDROGEN';
    case 'OPENROUTER_NEMOTRON':
      return 'AI_OPENROUTER_NEMOTRON';
    case 'OPENROUTER_KIMI':
      return 'AI_OPENROUTER_KIMI';
    case 'OPENROUTER_RESPAN':
      return 'AI_OPENROUTER_RESPAN';
    case 'OPENROUTER_RESPAN_PPLX':
      return 'AI_OPENROUTER_RESPAN_PPLX';
    case 'AIRFORCE':
      return 'AI_AIRFORCE';
    default:
      return 'AI_AUTO';
  }
}

function mapStrategyEnum(strategy?: EaConfig['strategyFocus']): string {
  switch (strategy) {
    case 'SCALPING_EMA':
      return 'STRAT_SCALPING_EMA';
    case 'ULTRA_SCALP':
      return 'STRAT_ULTRA_SCALP';
    case 'LIQUIDITY_SMC':
      return 'STRAT_LIQUIDITY_SMC';
    case 'BALANCED':
      return 'STRAT_BALANCED';
    default:
      return 'STRAT_ADAPTIVE_SCALP';
  }
}

function mapExecutionModeEnum(mode: Mt5ExecutionMode): string {
  switch (mode) {
    case 'HYBRID_AI_AND_WEB':
      return 'MODE_HYBRID_AI_AND_WEB';
    case 'STANDALONE_AI':
      return 'MODE_STANDALONE_AI';
    default:
      return 'MODE_COPY_WEB_ONLY';
  }
}

function mapScanSec(cadence?: EaConfig['analyzeCadence']): number {
  switch (cadence) {
    case '30S':
      return 30;
    case '60S':
      return 60;
    case '180S':
      return 180;
    default:
      return 0;
  }
}

export function buildBridgeFiles(
  origin: string,
  bridgeKey = '',
  config?: Partial<EaConfig>,
  executionMode: Mt5ExecutionMode = 'COPY_WEB_ONLY'
): BridgeFileAsset[] {
  const endpointUrl = `${origin}/api/ea/analyze`;
  const syncUrl = `${origin}/api/mt5/sync`;
  const safeBridgeKey = bridgeKey || 'MASUKKAN_BRIDGE_KEY_DARI_WEB';

  const aiProviderEnum = mapAiProviderEnum(config?.aiProvider);
  const strategyEnum = mapStrategyEnum(config?.strategyFocus);
  const execModeEnum = mapExecutionModeEnum(executionMode);
  const fullAiControl = config?.fullAiControl ?? true;
  const noSlAiExit = config?.noSlAiExit ?? true;
  const aiThinkingHigh = config?.aiThinkingHigh ?? true;
  const useRiskPercent = (config?.lotMode ?? 'RISK_PERCENT') === 'RISK_PERCENT';
  const riskPercent = (config?.riskPercent ?? 1.0).toFixed(2);
  const fixedLot = (config?.fixedLot ?? 0.05).toFixed(2);
  const maxOpenPositions = config?.maxOpenPositions ?? 2;
  const maxDailyLossPct = (config?.maxDailyLossPercent ?? 5.0).toFixed(2);
  const minConfidence = config?.minConfidence ?? 76;
  const scanSec = mapScanSec(config?.analyzeCadence);
  const useBreakeven = config?.useBreakeven ?? true;
  const beTrigPts = Math.max(10, Math.round((config?.breakevenTriggerUsd ?? 1.2) * 100));
  const useTrailingStop = config?.useTrailingStop ?? true;
  const trailingAtrMult = (config?.trailingAtrMultiplier ?? 0.9).toFixed(2);
  const allowSameSideLayer = config?.allowSameSideLayering ?? true;
  const sameSideMinConf = config?.sameSideMinConfidence ?? 80;
  const martingaleEnabled = config?.martingaleEnabled ?? true;
  const martingaleMult = (config?.martingaleMultiplier ?? 2.0).toFixed(2);

  const mq5Content = `//+------------------------------------------------------------------+
//|                                          AurumEA_XAUUSD_M5.mq5   |
//|   AI Decision Judge & Web Mirror Copier XAUUSD M5/M1             |
//+------------------------------------------------------------------+
#property copyright "AurumEA AI Judge Edition"
#property version   "2.30"
#property strict

#include <Trade\\Trade.mqh>

//--- Import DLL Windows x64 (letakkan di MQL5\\Libraries\\AurumGeminiBridge.dll)
#import "AurumGeminiBridge.dll"
int AurumAnalyzeM5(const string endpointUrl, const string jsonPayload, string &outBuffer, int outBufferLen);
#import

enum ENUM_EXECUTION_MODE
{
   MODE_COPY_WEB_ONLY = 0,     // Copy Order Web Saja (Mirror Lot, TP, SL & Close dari Web)
   MODE_HYBRID_AI_AND_WEB = 1, // Copy Order Web + Analisa AI Mandiri dari MT5
   MODE_STANDALONE_AI = 2      // Analisa AI Mandiri di MT5 Saja
};

enum ENUM_COPY_LOT_MODE
{
   COPY_EXACT_WEB_LOT = 0,     // Ikuti Persis Besaran Lot dari Web (x Multiplier)
   COPY_USE_MT5_RISK = 1       // Hitung Lot Sendiri Pakai Risk% / Fixed Lot Akun MT5 Ini
};

enum ENUM_AI_PROVIDER
{
   AI_AUTO = 0,                // Otomatis Failover (Gemini 4 -> Airforce -> OpenRouter)
   AI_ROUND_ROBIN = 1,         // Bergantian Merata (Round-Robin Multi-Engine)
   AI_GEMINI = 2,              // Hanya Gemini 4 Direct (Hydrogen / Argon)
   AI_OPENROUTER = 3,          // OpenRouter Alpha Decisions Pool (6 Model)
   AI_OPENROUTER_HEYGEN = 4,   // OpenRouter: heygen/heygen-decision-1-turbo
   AI_OPENROUTER_DREX = 5,     // OpenRouter: nace-ai/drex-max
   AI_OPENROUTER_JEV = 6,      // OpenRouter: typesafe/jev-1.14
   AI_OPENROUTER_PPLX = 7,     // OpenRouter: perplexity/pplx-decider-flash-v1.3:free
   AI_OPENROUTER_ARGON = 8,    // OpenRouter: google/gemini-4-argon
   AI_OPENROUTER_HYDROGEN = 9, // OpenRouter: google/gemini-4-hydrogen
   AI_AIRFORCE = 10,           // Hanya Airforce API (deepseek-v3)
   AI_OPENROUTER_NEMOTRON = 11,// OpenRouter Chat: nvidia/nemotron-3-ultra-550b-a55b:free
   AI_OPENROUTER_KIMI = 12,    // OpenRouter Chat: moonshotai/kimi-k3.1-pro
   AI_OPENROUTER_RESPAN = 13,  // OpenRouter Decisions: respan/span-01-lite:free
   AI_OPENROUTER_RESPAN_PPLX = 14 // OpenRouter Bergantian Cepat: Span-01-Lite <-> PPLX-Decider (Auto-Takeover)
};

enum ENUM_STRATEGY_FOCUS
{
   STRAT_SCALPING_EMA = 0,     // Scalping Momentum M5 (EMA 9/21/50 + Tight ATR)
   STRAT_ULTRA_SCALP = 1,      // Ultra-Scalping M1 + M5 (Sniper Micro Breakout)
   STRAT_LIQUIDITY_SMC = 2,    // Smart Money Concepts (Liquidity Sweep & BOS)
   STRAT_BALANCED = 3,         // Balanced Confluence (EMA + RSI + MACD + Price Action)
   STRAT_ADAPTIVE_SCALP = 4    // Auto Adaptive AI: Momentum M5 + Sniper M1+M5 (Winrate >80%)
};

input group "=== 1. Koneksi Web Terminal & Mode Copy Trade ==="
input string              InpEndpointUrl        = "${endpointUrl}";
input string              InpSyncUrl            = "${syncUrl}";
input string              InpBridgeKey          = "${safeBridgeKey}";
input ENUM_EXECUTION_MODE InpExecutionMode      = ${execModeEnum};
input ENUM_COPY_LOT_MODE  InpCopyLotMode        = COPY_EXACT_WEB_LOT;
input double              InpCopyLotMultiplier  = 1.00;             // Pengali Lot saat Copy Order dari Web (1.00 = sama persis)
input bool                InpUseDll             = true;             // true = pakai AurumGeminiBridge.dll, false = WebRequest bawaan MT5

input group "=== 2. Pemilihan Engine AI & Parameter (Sama Penuh dengan Web) ==="
input ENUM_AI_PROVIDER    InpAiProvider         = ${aiProviderEnum};
input bool                InpAiThinkingHigh     = ${aiThinkingHigh ? 'true' : 'false'}; // Deep Learning + Thinking HIGH (Multi-Engine)
input ENUM_STRATEGY_FOCUS InpStrategyFocus      = ${strategyEnum};
input bool                InpFullAiControl      = ${fullAiControl ? 'true' : 'false'}; // 100% Kendali AI Judge (Indikator hanya penunjang)
input bool                InpNoSlAiExit         = ${noSlAiExit ? 'true' : 'false'}; // 100% Tanpa SL (SL=0, TP aktif, AI Close jika win <20% & balik arah >=80%)

input group "=== 3. Kecepatan & Filter Opsional (Untuk Mode Hybrid / Standalone AI) ==="
input int      InpScalpScanSec       = ${scanSec};       // Interval scan saat belum ada posisi (detik). 0 = saat candle chart baru
input bool     InpPauseScanWhenOpen  = true;             // Diabaikan jika InpNoSlAiExit = true (AI wajib pantau posisi)
input int      InpTradeCooldownSec   = 45;               // Jeda minimal antar entry baru (detik)
input int      InpMinConfidence      = ${minConfidence}; // Hanya dipakai jika InpFullAiControl = false
input double   InpMaxSpreadPoints    = 35.0;             // Hanya dipakai jika InpFullAiControl = false
input double   InpMinAtrUsd          = 0.70;             // Hanya dipakai jika InpFullAiControl = false
input double   InpMaxAtrUsd          = 14.00;            // Hanya dipakai jika InpFullAiControl = false
input bool     InpUseSessionFilter   = false;            // Hanya dipakai jika InpFullAiControl = false
input int      InpSessionStartHour   = 7;                // Jam mulai sesi (Server Time)
input int      InpSessionEndHour     = 21;               // Jam selesai sesi (Server Time)

input group "=== 4. Manajemen Risiko & Lot ==="
input bool     InpUseRiskPercent     = ${useRiskPercent ? 'true' : 'false'}; // true = Lot dinamis (% Risk), false = Fixed Lot
input double   InpRiskPercent        = ${riskPercent};   // Risiko per trade (%)
input double   InpFixedLot           = ${fixedLot};      // Lot tetap jika InpUseRiskPercent = false
input int      InpMaxPositions       = ${maxOpenPositions}; // Maksimal posisi aktif bersamaan
input double   InpMaxDailyLossPct    = ${maxDailyLossPct}; // Batas rugi harian (%) sebelum stop entry baru
input bool     InpAllowSameSideLayer = ${allowSameSideLayer ? 'true' : 'false'}; // Buka posisi searah jika posisi aktif KEEP & keyakinan >= InpSameSideMinConf
input int      InpSameSideMinConf    = ${sameSideMinConf}; // Minimal keyakinan AI (%) untuk buka posisi searah / Martil
input bool     InpMartingaleEnabled  = ${martingaleEnabled ? 'true' : 'false'}; // Aktifkan pengali lot Martil saat buka posisi searah
input double   InpMartingaleMult     = ${martingaleMult}; // Pengali lot Martil untuk posisi ke-2 dst.
input int      InpMagicNumber        = 5052026;          // Magic Number EA

input group "=== 5. Proteksi Profit Scalping (Bypass saat InpNoSlAiExit = true) ==="
input bool     InpUseBreakeven       = ${useBreakeven ? 'true' : 'false'}; // Geser SL ke Breakeven+ otomatis (hanya jika InpNoSlAiExit = false)
input int      InpBreakevenTrigPts   = ${beTrigPts};     // Trigger BE saat profit >= points (120 pts = $1.20)
input int      InpBreakevenLockPts   = 20;               // Kunci profit saat BE (20 pts = $0.20)
input bool     InpUsePartialClose    = true;             // Tutup 50% lot otomatis saat profit mencapai target awal
input int      InpPartialTrigPts     = 150;              // Trigger Partial Close (150 pts = $1.50)
input bool     InpUseTrailingStop    = ${useTrailingStop ? 'true' : 'false'}; // Aktifkan Trailing Stop berbasis ATR (hanya jika InpNoSlAiExit = false)
input double   InpTrailingAtrMult    = ${trailingAtrMult}; // Pengali ATR untuk Trailing Stop scalping
input int      InpTrailStepPts       = 25;               // Minimal langkah geser SL (points)
input int      InpMaxHoldMinutes     = 25;               // Time-stop scalping (menit, 0 = nonaktif)

CTrade   trade;
datetime g_lastBarTime     = 0;
datetime g_lastScanTime    = 0;
datetime g_lastTradeTime   = 0;
int      g_atrHandle       = INVALID_HANDLE;
ulong    g_partialDoneTickets[];
int      g_syncTick        = 0;

//+------------------------------------------------------------------+
string AiProviderToString(ENUM_AI_PROVIDER p)
{
   switch(p)
   {
      case AI_ROUND_ROBIN:         return "ROUND_ROBIN";
      case AI_GEMINI:              return "GEMINI";
      case AI_OPENROUTER:          return "OPENROUTER";
      case AI_OPENROUTER_HEYGEN:   return "OPENROUTER_HEYGEN";
      case AI_OPENROUTER_DREX:     return "OPENROUTER_DREX";
      case AI_OPENROUTER_JEV:      return "OPENROUTER_JEV";
      case AI_OPENROUTER_PPLX:     return "OPENROUTER_PPLX";
      case AI_OPENROUTER_ARGON:    return "OPENROUTER_ARGON";
      case AI_OPENROUTER_HYDROGEN: return "OPENROUTER_HYDROGEN";
      case AI_OPENROUTER_NEMOTRON: return "OPENROUTER_NEMOTRON";
      case AI_OPENROUTER_KIMI:        return "OPENROUTER_KIMI";
      case AI_OPENROUTER_RESPAN:      return "OPENROUTER_RESPAN";
      case AI_OPENROUTER_RESPAN_PPLX: return "OPENROUTER_RESPAN_PPLX";
      case AI_AIRFORCE:               return "AIRFORCE";
      default:                        return "AUTO";
   }
}

//+------------------------------------------------------------------+
string StrategyFocusToString(ENUM_STRATEGY_FOCUS s)
{
   switch(s)
   {
      case STRAT_SCALPING_EMA:   return "SCALPING_EMA";
      case STRAT_ULTRA_SCALP:    return "ULTRA_SCALP";
      case STRAT_LIQUIDITY_SMC:  return "LIQUIDITY_SMC";
      case STRAT_BALANCED:       return "BALANCED";
      default:                   return "ADAPTIVE_SCALP";
   }
}

//+------------------------------------------------------------------+
double NormalizeVolume(double reqLot)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(lotStep <= 0) lotStep = 0.01;
   double stepped = MathFloor((reqLot + 1e-9) / lotStep) * lotStep;
   return MathMax(minLot, MathMin(maxLot, NormalizeDouble(stepped, 2)));
}

//+------------------------------------------------------------------+
int OnInit()
{
   if(Period() != PERIOD_M5)
   {
      Print("[AurumEA Scalper] Peringatan: Pasang di chart XAUUSD M5 untuk akurasi optimal.");
   }

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(25);
   g_atrHandle = iATR(_Symbol, PERIOD_M5, 14);

   EventSetTimer(1);
   if(InpExecutionMode != MODE_STANDALONE_AI)
   {
      SyncWithWebTerminal();
   }

   PrintFormat("[AurumEA v2.30] Akun=%I64d (%s) | Mode=%s | Engine=%s | ThinkHigh=%s | Strat=%s",
               AccountInfoInteger(ACCOUNT_LOGIN),
               AccountInfoString(ACCOUNT_SERVER),
               EnumToString(InpExecutionMode),
               AiProviderToString(InpAiProvider),
               (InpAiThinkingHigh ? "true" : "false"),
               StrategyFocusToString(InpStrategyFocus));
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   if(g_atrHandle != INVALID_HANDLE) IndicatorRelease(g_atrHandle);
}

//+------------------------------------------------------------------+
void OnTimer()
{
   if(InpExecutionMode != MODE_STANDALONE_AI)
   {
      SyncWithWebTerminal();
   }
}

//+------------------------------------------------------------------+
void OnTick()
{
   ManageScalpingPositions();

   // Mode Copy Web Saja: EA tidak membuka order sendiri agar 100% mengikuti hasil order & close dari Web Terminal
   if(InpExecutionMode == MODE_COPY_WEB_ONLY) return;

   datetime now = TimeCurrent();
   int eaPositions = CountEaPositions();

   if(eaPositions > 0)
   {
      if(InpNoSlAiExit)
      {
         int tfMonitorSec = PeriodSeconds(_Period);
         if(tfMonitorSec <= 0) tfMonitorSec = 300;
         if(g_lastScanTime != 0 && (now - g_lastScanTime) < tfMonitorSec) return;
         g_lastScanTime = now;
         RunGeminiAnalysisAndTrade();
         return;
      }
      if(InpPauseScanWhenOpen)
      {
         g_lastScanTime = now;
         datetime currentBarOpen = iTime(_Symbol, _Period, 0);
         if(currentBarOpen > 0) g_lastBarTime = currentBarOpen;
         return;
      }
   }

   if(InpScalpScanSec <= 0)
   {
      datetime currentBar = iTime(_Symbol, _Period, 0);
      if(currentBar == 0 || currentBar == g_lastBarTime) return;
      g_lastBarTime = currentBar;
   }
   else
   {
      if(g_lastScanTime != 0 && (now - g_lastScanTime) < InpScalpScanSec) return;
      g_lastScanTime = now;
   }

   RunGeminiAnalysisAndTrade();
}

//+------------------------------------------------------------------+
bool IsTicketPartialDone(ulong ticket)
{
   int sz = ArraySize(g_partialDoneTickets);
   for(int i = 0; i < sz; i++)
   {
      if(g_partialDoneTickets[i] == ticket) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
void MarkTicketPartialDone(ulong ticket)
{
   if(IsTicketPartialDone(ticket)) return;
   int sz = ArraySize(g_partialDoneTickets);
   ArrayResize(g_partialDoneTickets, sz + 1);
   g_partialDoneTickets[sz] = ticket;
}

//+------------------------------------------------------------------+
double GetTodayClosedProfit()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   dt.hour = 0; dt.min = 0; dt.sec = 0;
   datetime dayStart = StructToTime(dt);

   if(!HistorySelect(dayStart, TimeCurrent())) return 0.0;
   double total = 0.0;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != InpMagicNumber) continue;
      long entryType = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if(entryType == DEAL_ENTRY_OUT || entryType == DEAL_ENTRY_INOUT)
      {
         total += HistoryDealGetDouble(dealTicket, DEAL_PROFIT);
         total += HistoryDealGetDouble(dealTicket, DEAL_SWAP);
         total += HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
      }
   }
   return total;
}

//+------------------------------------------------------------------+
bool IsWithinTradingSession()
{
   if(!InpUseSessionFilter) return true;
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(InpSessionStartHour <= InpSessionEndHour)
      return (dt.hour >= InpSessionStartHour && dt.hour <= InpSessionEndHour);
   return (dt.hour >= InpSessionStartHour || dt.hour <= InpSessionEndHour);
}

//+------------------------------------------------------------------+
string SendHttpPost(const string url, const string payload, bool expectMt5Line)
{
   if(InpUseDll)
   {
      string outBuf = "";
      StringInit(outBuf, 8192, 0);
      int httpStatus = AurumAnalyzeM5(url, payload, outBuf, 8192);
      if(httpStatus != 200)
      {
         Print("[AurumEA DLL] HTTP=", httpStatus, " | URL=", url, " | ", outBuf);
         return "";
      }
      return outBuf;
   }
   else
   {
      char postData[];
      char result[];
      string resHeaders;
      StringToCharArray(payload, postData, 0, WHOLE_ARRAY, CP_UTF8);
      int sz = ArraySize(postData);
      if(sz > 0) ArrayResize(postData, sz - 1);

      string headers = "Content-Type: application/json\\r\\n";
      int status = WebRequest("POST", url, headers, 12000, postData, result, resHeaders);
      if(status != 200)
      {
         Print("[AurumEA WebRequest] HTTP=", status, " | Pastikan URL didaftarkan di Tools > Options > Expert Advisors");
         return "";
      }
      string jsonResp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return expectMt5Line ? ExtractMt5LineFromJson(jsonResp) : jsonResp;
   }
}

//+------------------------------------------------------------------+
void ExecuteCopiedOrder(const string action, double rawLots, double reqSl, double reqTp, const string cmt, double refEntry)
{
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = MathMax((stopsLevel + 2) * point, 10 * point);

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double execPrice = (action == "BUY") ? ask : bid;

   double sl = InpNoSlAiExit ? 0.0 : NormalizeDouble(reqSl, digits);
   double tp = NormalizeDouble(reqTp, digits);

   if(action == "BUY")
   {
      if(tp > 0)
      {
         if(tp <= ask + minDist && refEntry > 0 && tp > refEntry)
            tp = NormalizeDouble(ask + (tp - refEntry), digits);
         if(tp <= ask + minDist)
            tp = NormalizeDouble(ask + minDist, digits);
      }
      if(sl > 0)
      {
         if(sl >= ask - minDist && refEntry > 0 && sl < refEntry)
            sl = NormalizeDouble(ask - (refEntry - sl), digits);
         if(sl >= ask - minDist)
            sl = NormalizeDouble(ask - minDist, digits);
      }
   }
   else
   {
      if(tp > 0)
      {
         if(tp >= bid - minDist && refEntry > 0 && tp < refEntry)
            tp = NormalizeDouble(bid - (refEntry - tp), digits);
         if(tp >= bid - minDist)
            tp = NormalizeDouble(bid - minDist, digits);
      }
      if(sl > 0)
      {
         if(sl <= bid + minDist && refEntry > 0 && sl > refEntry)
            sl = NormalizeDouble(bid + (sl - refEntry), digits);
         if(sl <= bid + minDist)
            sl = NormalizeDouble(bid + minDist, digits);
      }
   }

   double lots = (InpCopyLotMode == COPY_EXACT_WEB_LOT)
                 ? NormalizeVolume(rawLots * InpCopyLotMultiplier)
                 : CalculateLotSize(execPrice, sl > 0 ? sl : execPrice);

   bool ok = false;
   if(action == "BUY")
      ok = trade.Buy(lots, _Symbol, ask, sl, tp, cmt);
   else
      ok = trade.Sell(lots, _Symbol, bid, sl, tp, cmt);

   if(ok)
      PrintFormat("[AurumEA Copy] %s %.2f lot @ %.2f | SL=%.2f | TP=%.2f | %s",
                  action, lots, execPrice, sl, tp, cmt);
   else
      PrintFormat("[AurumEA Copy GAGAL] %s %.2f lot | Retcode=%d (%s)",
                  action, lots, trade.ResultRetcode(), trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
void ExecuteCopiedClose(ulong ticket, const string sideHint, const string tagHint)
{
   if(ticket > 0 && PositionSelectByTicket(ticket))
   {
      if(PositionGetString(POSITION_SYMBOL) == _Symbol)
      {
         trade.PositionClose(ticket);
         PrintFormat("[AurumEA Copy] Menutup posisi ticket #%I64u", ticket);
         return;
      }
   }

   bool closedAny = false;
   if(tagHint != "")
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(t == 0 || PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         if(PositionGetString(POSITION_COMMENT) == tagHint)
         {
            if(trade.PositionClose(t)) closedAny = true;
         }
      }
      if(closedAny) return;
   }

   if(sideHint == "BUY" || sideHint == "SELL")
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(t == 0 || PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
         long pType = PositionGetInteger(POSITION_TYPE);
         if((sideHint == "BUY" && pType == POSITION_TYPE_BUY) ||
            (sideHint == "SELL" && pType == POSITION_TYPE_SELL))
         {
            trade.PositionClose(t);
            PrintFormat("[AurumEA Copy] Menutup posisi follower %s #%I64u", sideHint, t);
            return;
         }
      }
   }
}

//+------------------------------------------------------------------+
void ModifyPositionsTpBySide(const string side, double reqTp, ulong ticketHint, double refEntry, bool onlyEaMagic)
{
   if(reqTp <= 0) return;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = MathMax((stopsLevel + 2) * point, 10 * point);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double newTp = NormalizeDouble(reqTp, digits);
   if(side == "BUY")
   {
      if(newTp <= ask + minDist && refEntry > 0 && newTp > refEntry)
         newTp = NormalizeDouble(ask + (newTp - refEntry), digits);
      if(newTp <= ask + minDist)
         newTp = NormalizeDouble(ask + minDist, digits);
   }
   else if(side == "SELL")
   {
      if(newTp >= bid - minDist && refEntry > 0 && newTp < refEntry)
         newTp = NormalizeDouble(bid - (refEntry - newTp), digits);
      if(newTp >= bid - minDist)
         newTp = NormalizeDouble(bid - minDist, digits);
   }

   if(ticketHint > 0 && PositionSelectByTicket(ticketHint))
   {
      if(PositionGetString(POSITION_SYMBOL) == _Symbol)
      {
         double curSl = PositionGetDouble(POSITION_SL);
         double curTp = PositionGetDouble(POSITION_TP);
         if(MathAbs(curTp - newTp) >= point)
         {
            if(trade.PositionModify(ticketHint, curSl, newTp))
               PrintFormat("[AurumEA Copy] TP posisi #%I64u disamakan -> %.2f", ticketHint, newTp);
         }
         return;
      }
   }

   int updated = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0 || PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(onlyEaMagic && PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;

      long pType = PositionGetInteger(POSITION_TYPE);
      bool sideMatch = (side == "BUY" && pType == POSITION_TYPE_BUY) ||
                       (side == "SELL" && pType == POSITION_TYPE_SELL);
      if(!sideMatch) continue;

      double curSl = PositionGetDouble(POSITION_SL);
      double curTp = PositionGetDouble(POSITION_TP);
      if(MathAbs(curTp - newTp) >= point)
      {
         if(trade.PositionModify(t, curSl, newTp)) updated++;
      }
   }
   if(updated > 0)
      PrintFormat("[AurumEA TP Sync] %d posisi %s diperbarui TP -> %.2f (Prob >=85%%)", updated, side, newTp);
}

//+------------------------------------------------------------------+
void SyncWithWebTerminal()
{
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   bool sendCandles = (g_syncTick % 5 == 0);
   g_syncTick++;

   for(int step = 0; step < 10; step++)
   {
      string posJson = "[";
      int added = 0;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0) continue;
         if(added > 0) posJson += ",";
         long pType = PositionGetInteger(POSITION_TYPE);
         posJson += StringFormat(
            "{\\"ticket\\":%I64u,\\"symbol\\":\\"%s\\",\\"side\\":\\"%s\\",\\"lots\\":%.2f,\\"openPrice\\":%.*f,\\"sl\\":%.*f,\\"tp\\":%.*f,\\"profit\\":%.2f,\\"openTime\\":%I64d}",
            ticket,
            PositionGetString(POSITION_SYMBOL),
            (pType == POSITION_TYPE_BUY ? "BUY" : "SELL"),
            PositionGetDouble(POSITION_VOLUME),
            digits, PositionGetDouble(POSITION_PRICE_OPEN),
            digits, PositionGetDouble(POSITION_SL),
            digits, PositionGetDouble(POSITION_TP),
            PositionGetDouble(POSITION_PROFIT),
            (long)PositionGetInteger(POSITION_TIME) * 1000
         );
         added++;
      }
      posJson += "]";

      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      string m5SyncJson = (step == 0 && sendCandles) ? BuildCandlesArrayJson(PERIOD_M5, 100, digits) : "[]";

      string syncPayload = StringFormat(
         "{\\"bridgeKey\\":\\"%s\\",\\"login\\":\\"%I64d\\",\\"server\\":\\"%s\\",\\"company\\":\\"%s\\",\\"currency\\":\\"%s\\",\\"balance\\":%.2f,\\"equity\\":%.2f,\\"margin\\":%.2f,\\"freeMargin\\":%.2f,\\"leverage\\":%I64d,\\"tradeAllowed\\":%s,\\"symbol\\":\\"%s\\",\\"bid\\":%.*f,\\"ask\\":%.*f,\\"candles\\":%s,\\"positions\\":%s}",
         InpBridgeKey,
         AccountInfoInteger(ACCOUNT_LOGIN),
         AccountInfoString(ACCOUNT_SERVER),
         AccountInfoString(ACCOUNT_COMPANY),
         AccountInfoString(ACCOUNT_CURRENCY),
         AccountInfoDouble(ACCOUNT_BALANCE),
         AccountInfoDouble(ACCOUNT_EQUITY),
         AccountInfoDouble(ACCOUNT_MARGIN),
         AccountInfoDouble(ACCOUNT_MARGIN_FREE),
         AccountInfoInteger(ACCOUNT_LEVERAGE),
         (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) ? "true" : "false",
         _Symbol,
         digits, bid,
         digits, ask,
         m5SyncJson,
         posJson
      );

      string cmdLine = SendHttpPost(InpSyncUrl, syncPayload, true);
      if(cmdLine == "" || cmdLine == "NONE") break;

      string parts[];
      int n = StringSplit(cmdLine, '|', parts);
      if(n < 3 || parts[0] != "CMD") break;

      string action = parts[2];
      if((action == "BUY" || action == "SELL") && n >= 6)
      {
         double rawLots  = StringToDouble(parts[3]);
         double reqSl    = StringToDouble(parts[4]);
         double reqTp    = StringToDouble(parts[5]);
         string cmt      = (n > 6) ? parts[6] : "AurumEA Copy";
         double refEntry = (n > 7) ? StringToDouble(parts[7]) : 0.0;
         ExecuteCopiedOrder(action, rawLots, reqSl, reqTp, cmt, refEntry);
      }
      else if(action == "CLOSE" && n >= 4)
      {
         ulong ticket    = (ulong)StringToInteger(parts[3]);
         string sideHint = (n > 4) ? parts[4] : "";
         string tagHint  = (n > 5) ? parts[5] : "";
         ExecuteCopiedClose(ticket, sideHint, tagHint);
      }
      else if(action == "CLOSE_ALL")
      {
         for(int i = PositionsTotal() - 1; i >= 0; i--)
         {
            ulong t = PositionGetTicket(i);
            if(t > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol) trade.PositionClose(t);
         }
         Print("[AurumEA Copy] CLOSE_ALL dieksekusi dari Web Terminal.");
      }
      else if(action == "MODIFY_TP" && n >= 5)
      {
         string side      = parts[3];
         double reqTp     = StringToDouble(parts[4]);
         ulong ticketHint = (n > 5) ? (ulong)StringToInteger(parts[5]) : 0;
         double refEntry  = (n > 6) ? StringToDouble(parts[6]) : 0.0;
         ModifyPositionsTpBySide(side, reqTp, ticketHint, refEntry, false);
      }
   }
}

//+------------------------------------------------------------------+
int CountEaPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol &&
         PositionGetInteger(POSITION_MAGIC) == InpMagicNumber)
      {
         count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
string BuildCandlesArrayJson(ENUM_TIMEFRAMES tf, int countReq, int digits)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(_Symbol, tf, 0, countReq, rates);
   if(copied <= 0) return "[]";

   string arr = "[";
   for(int i = 0; i < copied; i++)
   {
      if(i > 0) arr += ",";
      arr += StringFormat(
         "{\\"time\\":%I64d,\\"open\\":%.*f,\\"high\\":%.*f,\\"low\\":%.*f,\\"close\\":%.*f,\\"volume\\":%I64d}",
         (long)rates[i].time,
         digits, rates[i].open,
         digits, rates[i].high,
         digits, rates[i].low,
         digits, rates[i].close,
         rates[i].tick_volume
      );
   }
   arr += "]";
   return arr;
}

//+------------------------------------------------------------------+
string GetActiveTimeframeCode()
{
   int sec = PeriodSeconds(_Period);
   if(sec >= 3600) return "H1";
   if(sec >= 1800) return "M30";
   if(sec >= 900)  return "M15";
   return "M5";
}

//+------------------------------------------------------------------+
string BuildRecentClosedTradesJson(int digits)
{
   datetime now = TimeCurrent();
   datetime fromTime = now - 7200; // 120 menit terakhir
   if(!HistorySelect(fromTime, now)) return "[]";

   string entries[];
   int total = HistoryDealsTotal();
   for(int i = total - 1; i >= 0 && ArraySize(entries) < 5; i--)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket == 0) continue;
      if(HistoryDealGetString(dealTicket, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(dealTicket, DEAL_MAGIC) != InpMagicNumber) continue;

      long entryType = HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
      if(entryType != DEAL_ENTRY_OUT && entryType != DEAL_ENTRY_INOUT) continue;

      long dealType = HistoryDealGetInteger(dealTicket, DEAL_TYPE);
      string posSide = (dealType == DEAL_TYPE_SELL) ? "BUY" : "SELL";
      double closePrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
      double pnl = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                 + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
                 + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
      long reasonCode = HistoryDealGetInteger(dealTicket, DEAL_REASON);
      string closeReason = "MT5 Sync";
      if(reasonCode == DEAL_REASON_TP) closeReason = "TP Hit";
      else if(reasonCode == DEAL_REASON_SL) closeReason = "SL Hit";
      else if(reasonCode == DEAL_REASON_EXPERT) closeReason = "AI Exit";

      datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
      long minsAgo = (long)MathMax(0, (long)((now - dealTime) / 60));

      int idx = ArraySize(entries);
      ArrayResize(entries, idx + 1);
      entries[idx] = StringFormat(
         "{\\"side\\":\\"%s\\",\\"entryPrice\\":%.*f,\\"closePrice\\":%.*f,\\"takeProfit\\":%.*f,\\"pnlUsd\\":%.2f,\\"points\\":0,\\"closeReason\\":\\"%s\\",\\"closedMinutesAgo\\":%I64d}",
         posSide,
         digits, closePrice,
         digits, closePrice,
         digits, closePrice,
         pnl,
         closeReason,
         minsAgo
      );
   }

   string json = "[";
   for(int k = 0; k < ArraySize(entries); k++)
   {
      if(k > 0) json += ",";
      json += entries[k];
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
string BuildMt5PayloadJson()
{
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   ENUM_TIMEFRAMES chartTf = _Period;
   if(PeriodSeconds(chartTf) < 300) chartTf = PERIOD_M5;
   string tfCandlesJson = BuildCandlesArrayJson(chartTf, 60, digits);
   if(StringLen(tfCandlesJson) < 20) return "";

   string m1Json = BuildCandlesArrayJson(PERIOD_M1, 15, digits);
   string recentClosedJson = BuildRecentClosedTradesJson(digits);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double spreadPts = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);

   string openDetailJson = "[";
   int addedPos = 0;
   datetime now = TimeCurrent();
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol ||
         PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;

      if(addedPos > 0) openDetailJson += ",";
      long pType = PositionGetInteger(POSITION_TYPE);
      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
      long minsAgo = (long)MathMax(0, (long)((now - openTime) / 60));
      openDetailJson += StringFormat(
         "{\\"id\\":\\"mt5_%I64u\\",\\"side\\":\\"%s\\",\\"lots\\":%.2f,\\"entryPrice\\":%.*f,\\"takeProfit\\":%.*f,\\"floatingPnlUsd\\":%.2f,\\"openedMinutesAgo\\":%I64d}",
         ticket,
         (pType == POSITION_TYPE_BUY ? "BUY" : "SELL"),
         PositionGetDouble(POSITION_VOLUME),
         digits, PositionGetDouble(POSITION_PRICE_OPEN),
         digits, PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         minsAgo
      );
      addedPos++;
   }
   openDetailJson += "]";

   return StringFormat(
      "{\\"strategyFocus\\":\\"%s\\",\\"aiProvider\\":\\"%s\\",\\"aiThinkingHigh\\":%s,\\"timeframe\\":\\"%s\\",\\"fullAiControl\\":%s,\\"noSlAiExit\\":%s,\\"riskPercent\\":%.2f,\\"accountBalance\\":%.2f,\\"openPositionsCount\\":%d,\\"openPositionsDetail\\":%s,\\"recentClosedTrades\\":%s,\\"mt5Symbol\\":\\"%s\\",\\"mt5Bid\\":%.*f,\\"mt5Ask\\":%.*f,\\"mt5SpreadPoints\\":%.1f,\\"mt5Candles\\":%s,\\"mt5M1Candles\\":%s}",
      StrategyFocusToString(InpStrategyFocus),
      AiProviderToString(InpAiProvider),
      (InpAiThinkingHigh ? "true" : "false"),
      GetActiveTimeframeCode(),
      (InpFullAiControl ? "true" : "false"),
      (InpNoSlAiExit ? "true" : "false"),
      InpRiskPercent,
      AccountInfoDouble(ACCOUNT_BALANCE),
      addedPos,
      openDetailJson,
      recentClosedJson,
      _Symbol,
      digits, bid,
      digits, ask,
      spreadPts,
      tfCandlesJson,
      m1Json
   );
}

//+------------------------------------------------------------------+
void CloseEaPositionsBySide(const string sideFilter)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol ||
         PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;

      long pType = PositionGetInteger(POSITION_TYPE);
      if(sideFilter == "ALL" ||
         (sideFilter == "BUY" && pType == POSITION_TYPE_BUY) ||
         (sideFilter == "SELL" && pType == POSITION_TYPE_SELL))
      {
         trade.PositionClose(ticket);
      }
   }
}

//+------------------------------------------------------------------+
void RunGeminiAnalysisAndTrade()
{
   int eaCount = CountEaPositions();
   if(!InpNoSlAiExit && InpPauseScanWhenOpen && eaCount > 0) return;

   if(eaCount == 0 && g_lastTradeTime != 0 && (TimeCurrent() - g_lastTradeTime) < InpTradeCooldownSec)
   {
      return;
   }

   double maxLossMoney = AccountInfoDouble(ACCOUNT_BALANCE) * (InpMaxDailyLossPct / 100.0);
   if(eaCount == 0 && GetTodayClosedProfit() <= -maxLossMoney)
   {
      Print("[AurumEA AI Judge] Batas rugi harian tercapai. Entry baru dihentikan hari ini.");
      return;
   }

   if(!InpFullAiControl && eaCount == 0)
   {
      if(!IsWithinTradingSession()) return;

      double spreadPts = (double)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
      if(spreadPts > InpMaxSpreadPoints)
      {
         Print("[AurumEA] Skip scan: Spread terlalu lebar (", spreadPts, " pts)");
         return;
      }

      if(g_atrHandle != INVALID_HANDLE)
      {
         double atrBuf[];
         if(CopyBuffer(g_atrHandle, 0, 0, 1, atrBuf) >= 1)
         {
            if(atrBuf[0] < InpMinAtrUsd || atrBuf[0] > InpMaxAtrUsd)
            {
               PrintFormat("[AurumEA] Skip scan: ATR M5 (%.2f) di luar rentang [%.2f - %.2f]",
                           atrBuf[0], InpMinAtrUsd, InpMaxAtrUsd);
               return;
            }
         }
      }
   }

   string payload = BuildMt5PayloadJson();
   if(payload == "") return;

   string mt5Line = SendHttpPost(InpEndpointUrl, payload, true);
   if(mt5Line == "") return;

   string fields[];
   int count = StringSplit(mt5Line, '|', fields);
   if(count < 6) return;

   string signal      = fields[0];
   int    confidence  = (int)StringToInteger(fields[1]);
   double sl          = StringToDouble(fields[3]);
   double tp1         = StringToDouble(fields[4]);
   string pattern     = (count > 6) ? fields[6] : "AI Judge";
   string summary     = (count > 7) ? fields[7] : "";
   string posDecision = (count > 8) ? fields[8] : "NONE";
   string posReason   = (count > 9) ? fields[9] : "";
   double highProbTp  = (count > 12) ? StringToDouble(fields[12]) : 0.0;

   PrintFormat("[AurumEA AI Judge (%s)] Vonis=%s | Conf=%d%% | PosDecision=%s | SLRef=%.2f | TP1=%.2f | HighProbTP=%.2f | %s",
               AiProviderToString(InpAiProvider), signal, confidence, posDecision, sl, tp1, highProbTp, summary);

   if(InpNoSlAiExit && eaCount > 0)
   {
      if(posDecision == "CLOSE_ALL")
      {
         Print("[AurumEA AI Exit] Menutup SEMUA posisi: ", posReason);
         CloseEaPositionsBySide("ALL");
         return;
      }
      if(posDecision == "CLOSE_BUY")
      {
         Print("[AurumEA AI Exit] Menutup posisi BUY: ", posReason);
         CloseEaPositionsBySide("BUY");
         return;
      }
      if(posDecision == "CLOSE_SELL")
      {
         Print("[AurumEA AI Exit] Menutup posisi SELL: ", posReason);
         CloseEaPositionsBySide("SELL");
         return;
      }
   }

   if(signal == "HOLD") return;
   if(CountEaPositions() >= InpMaxPositions) return;

   // Evaluasi posisi aktif searah (Layer/Martil) vs berlawanan arah (Anti-Hedging)
   string oppSide = (signal == "BUY") ? "SELL" : "BUY";
   int sameSideCount = 0;
   int oppSideCount = 0;
   double latestSameLot = 0.0;
   datetime latestSameTime = 0;
   double existingSameLots = 0.0;
   double existingSameWeightedSum = 0.0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol ||
         PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      long pType = PositionGetInteger(POSITION_TYPE);
      bool isSame = (signal == "BUY" && pType == POSITION_TYPE_BUY) ||
                    (signal == "SELL" && pType == POSITION_TYPE_SELL);
      if(!isSame)
      {
         oppSideCount++;
      }
      else
      {
         sameSideCount++;
         double pLot = PositionGetDouble(POSITION_VOLUME);
         double pOpen = PositionGetDouble(POSITION_PRICE_OPEN);
         datetime pTime = (datetime)PositionGetInteger(POSITION_TIME);
         existingSameLots += pLot;
         existingSameWeightedSum += pOpen * pLot;
         if(pTime >= latestSameTime)
         {
            latestSameTime = pTime;
            latestSameLot = pLot;
         }
      }
   }

   if(oppSideCount > 0)
   {
      PrintFormat("[AurumEA Anti-Hedging] Sinyal %s ditahan karena posisi %s masih aktif (KEEP).", signal, oppSide);
      return;
   }

   if(sameSideCount > 0)
   {
      if(!InpAllowSameSideLayer) return;
      if(confidence < InpSameSideMinConf)
      {
         PrintFormat("[AurumEA Layer] Sinyal %s ditahan: keyakinan %d%% < min %d%% untuk buka posisi sama/Martil.", signal, confidence, InpSameSideMinConf);
         return;
      }
   }
   else if(!InpFullAiControl && confidence < InpMinConfidence)
   {
      return;
   }

   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int stopsLevel = (int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDist = MathMax((stopsLevel + 2) * point, 10 * point);

   sl  = NormalizeDouble(sl, digits);
   tp1 = NormalizeDouble(tp1, digits);

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double execPrice = (signal == "BUY") ? ask : bid;
   double lots = CalculateLotSize(execPrice, sl);
   if(sameSideCount > 0 && InpMartingaleEnabled && latestSameLot > 0)
   {
      lots = NormalizeVolume(latestSameLot * MathMax(1.0, InpMartingaleMult));
   }

   double execTp = tp1;
   if(sameSideCount > 0)
   {
      if(highProbTp > 0) execTp = NormalizeDouble(highProbTp, digits);
      double combinedAvg = (existingSameWeightedSum + execPrice * lots) / (existingSameLots + lots);
      if(signal == "BUY")
      {
         double minAnchor = NormalizeDouble(MathMax(ask + minDist, combinedAvg + 0.30), digits);
         if(execTp < minAnchor) execTp = minAnchor;
      }
      else
      {
         double maxAnchor = NormalizeDouble(MathMin(bid - minDist, combinedAvg - 0.30), digits);
         if(execTp > maxAnchor) execTp = maxAnchor;
      }
   }

   double execSl = InpNoSlAiExit ? 0.0 : sl;
   string cmtPrefix = (sameSideCount > 0 && InpMartingaleEnabled) ? "Martil: " : "Scalp: ";

   bool ok = false;
   if(signal == "BUY" && (InpNoSlAiExit || sl < execPrice) && execTp > execPrice)
      ok = trade.Buy(lots, _Symbol, ask, execSl, execTp, cmtPrefix + pattern);
   else if(signal == "SELL" && (InpNoSlAiExit || sl > execPrice) && execTp < execPrice)
      ok = trade.Sell(lots, _Symbol, bid, execSl, execTp, cmtPrefix + pattern);

   if(ok)
   {
      g_lastTradeTime = TimeCurrent();
      if(sameSideCount > 0)
      {
         ModifyPositionsTpBySide(signal, execTp, 0, execPrice, true);
      }
   }
}

//+------------------------------------------------------------------+
double CalculateLotSize(double entryPrice, double stopLoss)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(!InpUseRiskPercent)
      return NormalizeVolume(InpFixedLot);

   double slDistance = MathAbs(entryPrice - stopLoss);
   double tickSize   = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   if(slDistance <= 0 || tickSize <= 0 || tickValue <= 0) return minLot;

   double riskMoney = AccountInfoDouble(ACCOUNT_BALANCE) * (InpRiskPercent / 100.0);
   double lossPerLot = (slDistance / tickSize) * tickValue;
   if(lossPerLot <= 0) return minLot;

   double rawLots = riskMoney / lossPerLot;
   return NormalizeVolume(rawLots);
}

//+------------------------------------------------------------------+
void ManageScalpingPositions()
{
   if(InpNoSlAiExit) return;

   double point   = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   int    digits  = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double bid     = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask     = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double trailDist = 0.0;
   if(InpUseTrailingStop && g_atrHandle != INVALID_HANDLE)
   {
      double atrBuf[];
      if(CopyBuffer(g_atrHandle, 0, 0, 1, atrBuf) >= 1)
         trailDist = atrBuf[0] * InpTrailingAtrMult;
   }

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol ||
         PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;

      long     posType  = PositionGetInteger(POSITION_TYPE);
      double   openPr   = PositionGetDouble(POSITION_PRICE_OPEN);
      double   curSl    = PositionGetDouble(POSITION_SL);
      double   curTp    = PositionGetDouble(POSITION_TP);
      double   vol      = PositionGetDouble(POSITION_VOLUME);
      datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);

      double gainPts = (posType == POSITION_TYPE_BUY)
                       ? (bid - openPr) / point
                       : (openPr - ask) / point;

      if(InpMaxHoldMinutes > 0 && (TimeCurrent() - openTime) >= InpMaxHoldMinutes * 60)
      {
         if(gainPts >= -30)
         {
            PrintFormat("[AurumEA Scalper] Time-stop (%dm) menutup #%I64u pada %.1f pts",
                        InpMaxHoldMinutes, ticket, gainPts);
            trade.PositionClose(ticket);
            continue;
         }
      }

      if(InpUsePartialClose && !IsTicketPartialDone(ticket) && gainPts >= InpPartialTrigPts)
      {
         double halfLot = MathFloor((vol * 0.5) / lotStep) * lotStep;
         if(halfLot >= minLot && (vol - halfLot) >= minLot)
         {
            if(trade.PositionClosePartial(ticket, halfLot))
            {
               MarkTicketPartialDone(ticket);
               PrintFormat("[AurumEA Scalper] Partial Close %.2f lot pada #%I64u (+%.0f pts)",
                           halfLot, ticket, gainPts);
            }
         }
         else
         {
            MarkTicketPartialDone(ticket);
         }
      }

      if(InpUseBreakeven && gainPts >= InpBreakevenTrigPts)
      {
         if(posType == POSITION_TYPE_BUY)
         {
            double beSl = NormalizeDouble(openPr + InpBreakevenLockPts * point, digits);
            if(beSl > curSl && beSl < bid)
            {
               trade.PositionModify(ticket, beSl, curTp);
               curSl = beSl;
            }
         }
         else
         {
            double beSl = NormalizeDouble(openPr - InpBreakevenLockPts * point, digits);
            if((curSl == 0 || beSl < curSl) && beSl > ask)
            {
               trade.PositionModify(ticket, beSl, curTp);
               curSl = beSl;
            }
         }
      }

      if(InpUseTrailingStop && trailDist > 0)
      {
         double minStep = InpTrailStepPts * point;
         if(posType == POSITION_TYPE_BUY && (bid - openPr) >= trailDist)
         {
            double newSl = NormalizeDouble(bid - trailDist, digits);
            if(newSl > curSl + minStep && newSl < bid)
               trade.PositionModify(ticket, newSl, curTp);
         }
         else if(posType == POSITION_TYPE_SELL && (openPr - ask) >= trailDist)
         {
            double newSl = NormalizeDouble(ask + trailDist, digits);
            if((curSl == 0 || newSl < curSl - minStep) && newSl > ask)
               trade.PositionModify(ticket, newSl, curTp);
         }
      }
   }
}

//+------------------------------------------------------------------+
string ExtractMt5LineFromJson(const string json)
{
   string key = "\\"mt5Line\\":\\"";
   int start = StringFind(json, key);
   if(start < 0) return "";
   start += StringLen(key);
   int end = StringFind(json, "\\"", start);
   if(end <= start) return "";
   return StringSubstr(json, start, end - start);
}
`;

  const cppContent = `// AurumGeminiBridge.cpp — Windows x64 WinHTTP DLL untuk MetaTrader 5
// Zero external dependencies (hanya Windows SDK WinHTTP + kernel32).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include "AurumGeminiBridge.h"

#pragma comment(lib, "winhttp.lib")

namespace {

std::string WideToUtf8(const wchar_t* wstr) {
    if (!wstr || !*wstr) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 0) return "";
    std::string out(len - 1, '\\0');
    WideCharToMultiByte(CP_UTF8, 0, wstr, -1, &out[0], len, nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(const std::string& str) {
    if (str.empty()) return L"";
    int len = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), static_cast<int>(str.size()), nullptr, 0);
    if (len <= 0) return L"";
    std::wstring out(len, L'\\0');
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), static_cast<int>(str.size()), &out[0], len);
    return out;
}

void WriteOutputWide(const std::wstring& msg, wchar_t* outBuffer, int outBufferLen) {
    if (!outBuffer || outBufferLen <= 0) return;
    wcsncpy_s(outBuffer, outBufferLen, msg.c_str(), _TRUNCATE);
}

std::string ExtractJsonStringField(const std::string& json, const std::string& fieldName) {
    const std::string token = "\\"" + fieldName + "\\":\\"";
    size_t pos = json.find(token);
    if (pos == std::string::npos) return "";
    pos += token.size();

    std::string result;
    result.reserve(256);
    bool escaped = false;
    for (size_t i = pos; i < json.size(); ++i) {
        char c = json[i];
        if (escaped) {
            if (c == 'n') result.push_back(' ');
            else result.push_back(c);
            escaped = false;
        } else if (c == '\\\\') {
            escaped = true;
        } else if (c == '"') {
            break;
        } else {
            result.push_back(c);
        }
    }
    return result;
}

} // namespace

extern "C" {

AURUM_API int __stdcall AurumAnalyzeM5(
    const wchar_t* endpointUrl,
    const wchar_t* jsonPayload,
    wchar_t* outBuffer,
    int outBufferLen
) {
    if (!endpointUrl || !jsonPayload || !outBuffer || outBufferLen <= 0) {
        WriteOutputWide(L"Parameter tidak valid", outBuffer, outBufferLen);
        return -1;
    }

    URL_COMPONENTS urlComp{};
    urlComp.dwStructSize = sizeof(urlComp);
    wchar_t hostBuf[256] = {};
    wchar_t pathBuf[1024] = {};
    urlComp.lpszHostName = hostBuf;
    urlComp.dwHostNameLength = _countof(hostBuf);
    urlComp.lpszUrlPath = pathBuf;
    urlComp.dwUrlPathLength = _countof(pathBuf);

    if (!WinHttpCrackUrl(endpointUrl, 0, 0, &urlComp)) {
        WriteOutputWide(L"URL endpoint tidak valid", outBuffer, outBufferLen);
        return -2;
    }

    HINTERNET hSession = WinHttpOpen(
        L"AurumEA-MT5-Bridge/1.2",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0
    );
    if (!hSession) {
        WriteOutputWide(L"Gagal inisialisasi WinHTTP session", outBuffer, outBufferLen);
        return -3;
    }

    WinHttpSetTimeouts(hSession, 5000, 8000, 10000, 20000);

    HINTERNET hConnect = WinHttpConnect(hSession, hostBuf, urlComp.nPort, 0);
    if (!hConnect) {
        WinHttpCloseHandle(hSession);
        WriteOutputWide(L"Gagal konek ke host endpoint", outBuffer, outBufferLen);
        return -4;
    }

    DWORD flags = (urlComp.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET hRequest = WinHttpOpenRequest(
        hConnect,
        L"POST",
        pathBuf,
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        flags
    );
    if (!hRequest) {
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        WriteOutputWide(L"Gagal membuat request HTTP", outBuffer, outBufferLen);
        return -5;
    }

    std::string utf8Body = WideToUtf8(jsonPayload);
    const wchar_t* headers = L"Content-Type: application/json\\r\\n";

    BOOL sent = WinHttpSendRequest(
        hRequest,
        headers,
        static_cast<DWORD>(-1),
        utf8Body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(utf8Body.data()),
        static_cast<DWORD>(utf8Body.size()),
        static_cast<DWORD>(utf8Body.size()),
        0
    );

    if (!sent || !WinHttpReceiveResponse(hRequest, nullptr)) {
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        WriteOutputWide(L"Timeout atau gagal menerima respon endpoint", outBuffer, outBufferLen);
        return -6;
    }

    DWORD statusCode = 0;
    DWORD statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(
        hRequest,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &statusCode,
        &statusSize,
        WINHTTP_NO_HEADER_INDEX
    );

    std::string responseBody;
    DWORD available = 0;
    while (WinHttpQueryDataAvailable(hRequest, &available) && available > 0) {
        std::vector<char> chunk(available);
        DWORD downloaded = 0;
        if (WinHttpReadData(hRequest, chunk.data(), available, &downloaded) && downloaded > 0) {
            responseBody.append(chunk.data(), downloaded);
        } else {
            break;
        }
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);

    if (statusCode == 200) {
        std::string mt5Line = ExtractJsonStringField(responseBody, "mt5Line");
        if (mt5Line.empty()) {
            WriteOutputWide(Utf8ToWide(responseBody), outBuffer, outBufferLen);
        } else {
            WriteOutputWide(Utf8ToWide(mt5Line), outBuffer, outBufferLen);
        }
    } else {
        std::string errMsg = ExtractJsonStringField(responseBody, "error");
        WriteOutputWide(Utf8ToWide(errMsg.empty() ? responseBody : errMsg), outBuffer, outBufferLen);
    }

    return static_cast<int>(statusCode);
}

} // extern "C"
`;

  const headerContent = `#pragma once

#ifdef AURUMGEMINIBRIDGE_EXPORTS
#define AURUM_API __declspec(dllexport)
#else
#define AURUM_API __declspec(dllimport)
#endif

extern "C" {
    AURUM_API int __stdcall AurumAnalyzeM5(
        const wchar_t* endpointUrl,
        const wchar_t* jsonPayload,
        wchar_t* outBuffer,
        int outBufferLen
    );
}
`;

  const defContent = `LIBRARY AurumGeminiBridge
EXPORTS
    AurumAnalyzeM5
`;

  const batContent = `@echo off
setlocal
echo === Build AurumGeminiBridge.dll (Windows x64 untuk MetaTrader 5) ===

where cl >nul 2>nul
if %errorlevel%==0 (
    echo [MSVC] Mengompilasi dengan Visual Studio cl.exe...
    cl /LD /O2 /EHsc /DAURUMGEMINIBRIDGE_EXPORTS AurumGeminiBridge.cpp AurumGeminiBridge.def winhttp.lib /Fe:AurumGeminiBridge.dll
    goto :done
)

where x86_64-w64-mingw32-g++ >nul 2>nul
if %errorlevel%==0 (
    echo [MinGW-w64] Mengompilasi dengan x86_64-w64-mingw32-g++...
    x86_64-w64-mingw32-g++ -shared -O2 -DAURUMGEMINIBRIDGE_EXPORTS -municode AurumGeminiBridge.cpp AurumGeminiBridge.def -lwinhttp -static-libgcc -static-libstdc++ -o AurumGeminiBridge.dll
    goto :done
)

where g++ >nul 2>nul
if %errorlevel%==0 (
    echo [MinGW g++] Mengompilasi dengan g++...
    g++ -shared -O2 -DAURUMGEMINIBRIDGE_EXPORTS AurumGeminiBridge.cpp AurumGeminiBridge.def -lwinhttp -static-libgcc -static-libstdc++ -o AurumGeminiBridge.dll
    goto :done
)

echo [ERROR] Tidak ditemukan compiler MSVC (cl.exe) atau MinGW-w64 g++.
echo Jalankan script ini dari "x64 Native Tools Command Prompt for VS" atau install MinGW-w64.
exit /b 1

:done
if exist AurumGeminiBridge.dll (
    echo.
    echo SUKSES! File AurumGeminiBridge.dll siap disalin ke:
    echo   [Data Folder MT5]\\MQL5\\Libraries\\AurumGeminiBridge.dll
)
endlocal
`;

  return [
    {
      id: 'mq5',
      filename: 'AurumEA_XAUUSD_M5.mq5',
      label: 'Expert Advisor MT5 (.mq5)',
      targetFolder: 'MQL5\\Experts\\',
      content: mq5Content,
    },
    {
      id: 'cpp',
      filename: 'AurumGeminiBridge.cpp',
      label: 'Source C++ DLL (.cpp)',
      targetFolder: 'Build Folder',
      content: cppContent,
    },
    {
      id: 'header',
      filename: 'AurumGeminiBridge.h',
      label: 'Header C++ DLL (.h)',
      targetFolder: 'Build Folder',
      content: headerContent,
    },
    {
      id: 'def',
      filename: 'AurumGeminiBridge.def',
      label: 'Export Def (.def)',
      targetFolder: 'Build Folder',
      content: defContent,
    },
    {
      id: 'bat',
      filename: 'build_dll.bat',
      label: 'Script Build DLL (.bat)',
      targetFolder: 'Build Folder',
      content: batContent,
    },
  ];
}
