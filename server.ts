import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import crypto from 'crypto';
import {
  BROKER_FEEDS,
  TIMEFRAME_META,
  type AiProviderMode,
  type BrokerFeedId,
  type Candle,
  type ChartTimeframe,
  type EaAnalysisResult,
  type MacroContext,
  type MarketQuote,
  type MarketSnapshot,
  type Mt5AccountConfig,
  type Mt5BridgeStatus,
  type Mt5LivePosition,
  type PositionDecision,
  type PostTpDecision,
  type RecentClosedTradeContext,
} from './src/types/trading.ts';
import { analyzeChartStructure, buildIndicatorPack } from './src/utils/indicators.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

// Shared Gemini client pool with automatic multi-key fallback (API Key 1 -> Key 2 -> Key 3...)
interface GeminiKeySlot {
  name: string;
  key: string;
}

const geminiKeyCooldownUntil = new Map<string, number>();

function isPlaceholderGeminiKey(value: string): boolean {
  const upper = value.toUpperCase();
  return (
    !value ||
    upper.startsWith('MY_') ||
    upper.includes('PLACEHOLDER') ||
    value.includes('BEGIN PRIVATE KEY') ||
    value.length < 16
  );
}

function sanitizeSecretToken(raw: string): string {
  let cleaned = raw.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  cleaned = cleaned.replace(/^bearer\s+/i, '').trim();
  return cleaned;
}

function getConfiguredGeminiKeys(): GeminiKeySlot[] {
  const explicitOrder = [
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_1',
    'GEMINI_API_KEY1',
    'GEMINI_API_KEY_2',
    'GEMINI_API_KEY2',
    'GEMINI_API_KEY_3',
    'GEMINI_API_KEY3',
    'GEMINI_API_KEY_4',
    'GEMINI_API_KEY_5',
  ];

  const dynamicExtra = Object.keys(process.env)
    .filter(
      (name) =>
        !explicitOrder.includes(name) &&
        /^(GEMINI.*KEY|GOOGLE_GEMINI.*KEY|API_KEY_?\d+)$/i.test(name)
    )
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const valid: GeminiKeySlot[] = [];
  const seenKeys = new Set<string>();

  for (const name of [...explicitOrder, ...dynamicExtra]) {
    const raw = process.env[name];
    if (!raw) continue;

    // Support either single key or comma/newline-separated keys in a secret
    const parts = raw
      .split(/[,\r\n]+/)
      .map((s) => sanitizeSecretToken(s))
      .filter(Boolean);

    parts.forEach((trimmed, idx) => {
      if (isPlaceholderGeminiKey(trimmed) || seenKeys.has(trimmed)) {
        return;
      }
      seenKeys.add(trimmed);
      valid.push({
        name: parts.length > 1 ? `${name}#${idx + 1}` : name,
        key: trimmed,
      });
    });
  }

  return valid;
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isGeminiRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('429') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('exceeded')
  );
}

function isGeminiFallbackEligibleError(err: unknown): boolean {
  if (isGeminiRateLimitError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('API_KEY_INVALID') ||
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('UNAVAILABLE') ||
    /\b(403|429|500|502|503|504)\b/.test(msg)
  );
}

async function generateWithGeminiFallback(
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
  options?: { fastFailWhenAllCooldown?: boolean }
) {
  const keys = getConfiguredGeminiKeys();
  if (keys.length === 0) {
    throw new Error(
      'GEMINI_API_KEY belum terkonfigurasi. Pastikan API key tersedia di Settings > Secrets.'
    );
  }

  const now = Date.now();
  const readyKeys = keys.filter((k) => (geminiKeyCooldownUntil.get(k.name) ?? 0) <= now);
  if (readyKeys.length === 0 && options?.fastFailWhenAllCooldown) {
    throw new Error(
      `RESOURCE_EXHAUSTED: Semua ${keys.length} API key Gemini sedang dalam cooldown kuota (429).`
    );
  }

  const cooldownKeys = keys
    .filter((k) => (geminiKeyCooldownUntil.get(k.name) ?? 0) > now)
    .sort(
      (a, b) =>
        (geminiKeyCooldownUntil.get(a.name) ?? 0) - (geminiKeyCooldownUntil.get(b.name) ?? 0)
    );
  const orderedKeys = [...readyKeys, ...cooldownKeys];

  let lastError: unknown = null;

  for (let i = 0; i < orderedKeys.length; i++) {
    const slot = orderedKeys[i];
    const ai = createGeminiClient(slot.key);
    try {
      const response = await ai.models.generateContent(params);
      geminiKeyCooldownUntil.delete(slot.name);
      return { response, keySlotName: slot.name };
    } catch (err) {
      lastError = err;
      const hasMoreKeys = i < orderedKeys.length - 1;
      const isQuota = isGeminiRateLimitError(err);
      const rawMsg = err instanceof Error ? err.message : String(err);
      const isTransient503 = rawMsg.includes('UNAVAILABLE') || /\b(502|503|504)\b/.test(rawMsg);

      if (isTransient503) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const retryRes = await ai.models.generateContent(params);
          geminiKeyCooldownUntil.delete(slot.name);
          return { response: retryRes, keySlotName: slot.name };
        } catch (retryErr) {
          lastError = retryErr;
        }
      }

      if (isGeminiFallbackEligibleError(err) && !isTransient503) {
        const cooldownMs = isQuota ? 60_000 : 300_000;
        geminiKeyCooldownUntil.set(slot.name, Date.now() + cooldownMs);
      }

      if (isGeminiFallbackEligibleError(err) && hasMoreKeys) {
        const nextSlot = orderedKeys[i + 1];
        console.warn(
          `[Gemini Fallback] ${slot.name} (${i + 1}/${orderedKeys.length}) gagal (${
            isQuota ? '429/Kuota' : isTransient503 ? '503/Server Padat' : 'Auth/Permission'
          }). Otomatis beralih ke ${nextSlot.name} (${i + 2}/${orderedKeys.length}).`
        );
        continue;
      }
      throw lastError;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Semua ${orderedKeys.length} API key Gemini mencapai batas kuota (429).`);
}

function extractJsonObjectString(raw: string): string {
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned.replace(/,\s*([}\]])/g, '$1');
}

interface AirforceConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

class AirforceError extends Error {
  statusCode: number;
  detail: string;
  constructor(statusCode: number, detail: string) {
    super(`Airforce HTTP ${statusCode}: ${detail}`);
    this.name = 'AirforceError';
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

const airforceEngineCooldownUntil = new Map<string, number>();
let aiRoundRobinCursor = 0;
let respanPplxCursor = 0;

function sanitizeAirforceUrl(raw: string, fallbackUrl: string): string {
  const cleaned = sanitizeSecretToken(raw);
  const match = cleaned.match(/https?:\/\/[^\s"'\\]+/i);
  if (match) {
    try {
      const u = new URL(match[0]);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        return u.toString().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
      }
    } catch {
      // Fallback below
    }
  }
  return fallbackUrl;
}

function getAirforceConfig(): AirforceConfig | null {
  const candidates = ['AIRFORCE_API_KEY', 'AIRFORCE_KEY', 'API_AIRFORCE_KEY'];
  let apiKey = '';
  for (const name of candidates) {
    const val = sanitizeSecretToken(process.env[name] || '');
    if (val && !isPlaceholderGeminiKey(val)) {
      apiKey = val;
      break;
    }
  }
  if (!apiKey) return null;

  const baseUrl = sanitizeAirforceUrl(
    process.env.AIRFORCE_BASE_URL || 'https://api.airforce/v1',
    'https://api.airforce/v1'
  );
  const rawModel = (process.env.AIRFORCE_MODEL || '').trim().replace(/^["']|["']$/g, '');
  const model = rawModel || 'deepseek-v3';
  return { apiKey, baseUrl, model };
}

function isEngineFailureEligibleForRotation(err: unknown): boolean {
  if (err instanceof AirforceError || err instanceof OpenRouterError) {
    return (
      err.statusCode === 429 ||
      err.statusCode === 402 ||
      err.statusCode === 408 ||
      err.statusCode >= 500
    );
  }
  return isGeminiFallbackEligibleError(err);
}

interface OpenRouterDecisionsConfig {
  apiKey: string;
  decisionsUrl: string;
  chatUrl: string;
  model: string;
  respanModel: string;
  heygenModel: string;
  drexModel: string;
  jevModel: string;
  argonModel: string;
  hydrogenModel: string;
  nemotronModel: string;
  kimiModel: string;
}

class OpenRouterError extends Error {
  statusCode: number;
  detail: string;
  constructor(statusCode: number, detail: string) {
    super(`OpenRouter HTTP ${statusCode}: ${detail}`);
    this.name = 'OpenRouterError';
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function sanitizeOpenRouterUrl(raw: string, fallbackUrl: string): string {
  const cleaned = sanitizeSecretToken(raw);
  const match = cleaned.match(/https?:\/\/[^\s"'\\]+/i);
  if (match) {
    try {
      const u = new URL(match[0]);
      if (
        (u.protocol === 'https:' || u.protocol === 'http:') &&
        (u.hostname === 'openrouter.ai' || u.hostname.endsWith('.openrouter.ai'))
      ) {
        return u.toString().replace(/\/+$/, '');
      }
    } catch {
      // Fallback below
    }
  }
  return fallbackUrl;
}

function getOpenRouterDecisionsConfig(): OpenRouterDecisionsConfig | null {
  const candidates = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_KEY',
    'OPENROUTER_DECISIONS_KEY',
    'API_OPENROUTER_KEY',
  ];
  let apiKey = '';
  for (const name of candidates) {
    const val = sanitizeSecretToken(process.env[name] || '');
    if (val && !isPlaceholderGeminiKey(val)) {
      apiKey = val;
      break;
    }
  }
  if (!apiKey) return null;

  const decisionsUrl = 'https://openrouter.ai/api/alpha/decisions';
  const chatUrl = 'https://openrouter.ai/api/v1/chat/completions';
  const model = 'perplexity/pplx-decider-flash-v1.3:free';
  const respanModel = 'respan/span-01-lite:free';
  const heygenModel = 'heygen/heygen-decision-1-turbo';
  const drexModel = 'nace-ai/drex-max';
  const jevModel = 'typesafe/jev-1.14';
  const argonModel = 'google/gemini-4-argon';
  const hydrogenModel = 'google/gemini-4-hydrogen';
  const nemotronModel = 'nvidia/nemotron-3-ultra-550b-a55b:free';
  const kimiModel = 'moonshotai/kimi-k3.1-pro';

  return {
    apiKey,
    decisionsUrl,
    chatUrl,
    model,
    respanModel,
    heygenModel,
    drexModel,
    jevModel,
    argonModel,
    hydrogenModel,
    nemotronModel,
    kimiModel,
  };
}

async function generateAnalysisViaAirforce(opts: {
  cfg: AirforceConfig;
  systemInstruction: string;
  promptText: string;
  thinkingHigh?: boolean;
}): Promise<{ rawText: string; model: string }> {
  const { cfg, systemInstruction, promptText, thinkingHigh = true } = opts;

  const jsonContract = `

ATURAN OUTPUT JSON (AIRFORCE ${cfg.model.toUpperCase()}):
- ${
    thinkingHigh
      ? 'MODE ANALISA MENDALAM AKTIF: Evaluasi mendalam namun ringkas pada Peta Support/Resistance, struktur harga, chart/candlestick pattern, k-NN, dan Order Flow, lalu WAJIB keluarkan 1 objek JSON valid.'
      : 'Berpikir singkat lalu langsung keluarkan 1 objek JSON valid.'
  }
- Balas HANYA dengan 1 objek JSON valid (tanpa markdown code fence) persis berformat:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": number (0-100),
  "marketBias": "BULLISH" | "BEARISH" | "RANGING",
  "positionDecision": "NONE" | "KEEP" | "CLOSE_BUY" | "CLOSE_SELL" | "CLOSE_ALL",
  "positionReason": string,
  "winProbability": number (0-100, estimasi peluang posisi terbuka hit TP),
  "reversalConfidence": number (0-100, keyakinan harga akan berubah arah melawan posisi),
  "highProbTp": number (target TP gabungan dengan probabilitas tersentuh minimal 85% jika dibuka posisi sama/martil),
  "highProbTpConfidence": number (85-99, probabilitas highProbTp tersentuh),
  "postTpEvaluation": "NONE" | "RE_ENTRY_CONTINUATION" | "WAIT_PULLBACK_HOLD" | "EXHAUSTION_SKIP",
  "postTpReason": string,
  "keyLevelsSummary": string,
  "judgeVerdict": string,
  "indicatorWeighting": string,
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit1": number,
  "takeProfit2": number,
  "riskRewardRatio": string,
  "setupPattern": string,
  "summary": string,
  "keyFactors": string[],
  "invalidatedIf": string
}`;

  const callEndpoint = async (useResponseFormat: boolean): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 38_000);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `${promptText}${jsonContract}` },
          ],
          temperature: 0.2,
          max_tokens: 1600,
          stream: false,
          ...(useResponseFormat ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      const rawBody = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        // Keep raw body text for diagnostics
      }

      if (!res.ok) {
        const errObj = parsed.error as { message?: string } | string | undefined;
        const detail =
          typeof errObj === 'string'
            ? errObj
            : errObj?.message || rawBody.slice(0, 240) || `HTTP ${res.status}`;
        throw new AirforceError(res.status, detail);
      }

      const choices = parsed.choices as
        | Array<{ message?: { content?: string; reasoning_content?: string } }>
        | undefined;
      const msgObj = choices?.[0]?.message;
      const content = String(msgObj?.content || '');
      const reasoning = String(msgObj?.reasoning_content || '');

      let extracted = extractJsonObjectString(content);
      if ((!extracted || !extracted.startsWith('{')) && reasoning) {
        const fromReasoning = extractJsonObjectString(reasoning);
        if (fromReasoning.startsWith('{') && fromReasoning.endsWith('}')) {
          extracted = fromReasoning;
        }
      }
      if (!extracted || !extracted.startsWith('{')) {
        throw new AirforceError(
          502,
          `Model Airforce (${cfg.model}) belum mengembalikan blok JSON valid.`
        );
      }
      return extracted;
    } catch (err) {
      if (err instanceof AirforceError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      throw new AirforceError(
        isAbort ? 408 : 502,
        isAbort ? `Timeout menghubungi Airforce (${cfg.model}).` : msg
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let useJsonFmt = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rawText = await callEndpoint(useJsonFmt);
      return {
        rawText,
        model: `airforce/${cfg.model}`,
      };
    } catch (err) {
      const isFormatErr =
        err instanceof AirforceError &&
        (err.statusCode === 400 || err.statusCode === 422) &&
        /response_format|json_object/i.test(err.detail);
      if (useJsonFmt && isFormatErr) {
        useJsonFmt = false;
        continue;
      }
      throw err;
    }
  }

  throw new AirforceError(502, `Gagal mendapatkan respon valid dari Airforce (${cfg.model}).`);
}

async function generateAnalysisViaOpenRouterChat(opts: {
  cfg: OpenRouterDecisionsConfig;
  modelName: string;
  systemInstruction: string;
  promptText: string;
  chartImageBase64?: string;
  thinkingHigh?: boolean;
}): Promise<{ rawText: string; model: string; usedChartVision: boolean }> {
  const {
    cfg,
    modelName,
    systemInstruction,
    promptText,
    chartImageBase64,
    thinkingHigh = true,
  } = opts;

  const jsonContract = `

ATURAN OUTPUT JSON (OPENROUTER ${modelName.toUpperCase()}):
- ${
    thinkingHigh
      ? 'MODE ANALISA MENDALAM AKTIF: Lakukan pembacaan visual chart (Bid/Ask & sumbu Y), peta Support/Resistance, struktur harga M5-H4, DXY/geopolitik, dan audit trade terdahulu, lalu WAJIB keluarkan 1 objek JSON valid.'
      : 'Analisa ringkas lalu langsung keluarkan 1 objek JSON valid.'
  }
- Balas HANYA dengan 1 objek JSON valid (tanpa markdown code fence) persis berformat:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": number (0-100),
  "marketBias": "BULLISH" | "BEARISH" | "RANGING",
  "positionDecision": "NONE" | "KEEP" | "CLOSE_BUY" | "CLOSE_SELL" | "CLOSE_ALL",
  "positionReason": string,
  "winProbability": number (0-100, estimasi peluang posisi terbuka hit TP),
  "reversalConfidence": number (0-100, keyakinan harga akan berubah arah melawan posisi),
  "highProbTp": number (target TP gabungan dengan probabilitas tersentuh minimal 85% jika dibuka posisi sama/martil),
  "highProbTpConfidence": number (85-99, probabilitas highProbTp tersentuh),
  "postTpEvaluation": "NONE" | "RE_ENTRY_CONTINUATION" | "WAIT_PULLBACK_HOLD" | "EXHAUSTION_SKIP",
  "postTpReason": string,
  "keyLevelsSummary": string,
  "judgeVerdict": string,
  "indicatorWeighting": string,
  "ocrExtractedPrice": string,
  "globalSyncSummary": string,
  "macroSummary": string,
  "mtfSummary": string,
  "entryPrice": number,
  "stopLoss": number,
  "takeProfit1": number,
  "takeProfit2": number,
  "riskRewardRatio": string,
  "setupPattern": string,
  "summary": string,
  "keyFactors": string[],
  "invalidatedIf": string
}`;

  const isReasoningChat = /nemotron|kimi/i.test(modelName);
  const supportsVision = !/nemotron/i.test(modelName);

  const callChat = async (
    withImage: boolean,
    useResponseFormat: boolean,
    useReasoningEffort: boolean
  ): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), isReasoningChat ? 110_000 : 45_000);
    try {
      const userContent =
        withImage && chartImageBase64
          ? [
              { type: 'text', text: `${promptText}${jsonContract}` },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${chartImageBase64}` },
              },
            ]
          : `${promptText}${jsonContract}`;

      const res = await fetch(cfg.chatUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://aurumea.local',
          'X-Title': 'AurumEA XAUUSD M5',
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent },
          ],
          temperature: 0.2,
          max_tokens: isReasoningChat ? 8000 : 3000,
          stream: false,
          ...(useReasoningEffort && isReasoningChat
            ? {
                reasoning: /nemotron/i.test(modelName)
                  ? { enabled: false }
                  : { effort: 'low' },
              }
            : {}),
          ...(useResponseFormat ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      const rawBody = await res.text();
      const trimmed = rawBody.trim();
      if (trimmed.startsWith('<')) {
        throw new OpenRouterError(
          res.status >= 400 ? res.status : 502,
          'Gateway OpenRouter merespon halaman non-JSON.'
        );
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = trimmed ? (JSON.parse(trimmed) as Record<string, unknown>) : {};
      } catch {
        throw new OpenRouterError(
          res.status >= 400 ? res.status : 502,
          `Respon OpenRouter non-JSON: ${trimmed.slice(0, 160)}`
        );
      }

      if (!res.ok) {
        const errObj = parsed.error as { message?: string } | string | undefined;
        const detail =
          typeof errObj === 'string'
            ? errObj
            : errObj?.message ||
              (typeof parsed.message === 'string' ? parsed.message : '') ||
              trimmed.slice(0, 220) ||
              `HTTP ${res.status}`;
        throw new OpenRouterError(res.status, detail);
      }

      const choices = parsed.choices as
        | Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>
        | undefined;
      const msgObj = choices?.[0]?.message;
      const content = String(msgObj?.content || '');
      const reasoning = String(msgObj?.reasoning_content || msgObj?.reasoning || '');

      let extracted = extractJsonObjectString(content);
      if ((!extracted || !extracted.startsWith('{')) && reasoning) {
        const fromReasoning = extractJsonObjectString(reasoning);
        if (fromReasoning.startsWith('{') && fromReasoning.endsWith('}')) {
          extracted = fromReasoning;
        }
      }
      if (!extracted || !extracted.startsWith('{')) {
        throw new OpenRouterError(
          502,
          `Model OpenRouter (${modelName}) belum mengembalikan blok JSON valid.`
        );
      }
      try {
        JSON.parse(extracted);
      } catch {
        throw new OpenRouterError(
          502,
          `Model OpenRouter (${modelName}) mengembalikan JSON tidak valid.`
        );
      }
      return extracted;
    } catch (err) {
      if (err instanceof OpenRouterError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      throw new OpenRouterError(
        isAbort ? 408 : 502,
        isAbort ? `Timeout menghubungi OpenRouter (${modelName}).` : msg
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let withImage = Boolean(chartImageBase64) && supportsVision;
  let useFmt = true;
  let useReasoning = isReasoningChat;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const rawText = await callChat(withImage, useFmt, useReasoning);
      return {
        rawText,
        model: `openrouter/${modelName}`,
        usedChartVision: withImage,
      };
    } catch (err) {
      if (err instanceof OpenRouterError) {
        if (
          useReasoning &&
          (err.statusCode === 400 || err.statusCode === 422) &&
          /reasoning/i.test(err.detail)
        ) {
          useReasoning = false;
          continue;
        }
        if (
          useFmt &&
          (err.statusCode === 400 || err.statusCode === 422) &&
          /response_format|json_object/i.test(err.detail)
        ) {
          useFmt = false;
          continue;
        }
        if (
          withImage &&
          (err.statusCode === 400 ||
            err.statusCode === 422 ||
            (err.statusCode === 404 && /image|vision|multimodal/i.test(err.detail)))
        ) {
          withImage = false;
          continue;
        }
        if (attempt === 0 && err.statusCode === 502 && /JSON/i.test(err.detail)) {
          useFmt = true;
          continue;
        }
      }
      throw err;
    }
  }
  throw new OpenRouterError(502, `Gagal mendapatkan respon valid dari ${modelName}.`);
}

async function generateAnalysisViaOpenRouterDecisions(opts: {
  cfg: OpenRouterDecisionsConfig;
  modelOverride?: string;
  timeoutMs?: number;
  systemInstruction: string;
  promptText: string;
  chartImageBase64?: string;
  snapshot: MarketSnapshot;
  chartStructure: ReturnType<typeof analyzeChartStructure>;
  atrValue: number;
  isScalpMode: boolean;
  openPositionsCount: number;
  hasRecentClosedContext: boolean;
}): Promise<{ rawText: string; model: string; usedChartVision: boolean }> {
  const {
    cfg,
    modelOverride,
    timeoutMs = 32_000,
    systemInstruction,
    promptText,
    chartImageBase64,
    snapshot,
    chartStructure,
    atrValue,
    isScalpMode,
    openPositionsCount,
    hasRecentClosedContext,
  } = opts;
  const activeDecisionModel = modelOverride || cfg.model;
  const isRespanModel = /^respan\//i.test(activeDecisionModel);

  const questions: Record<string, unknown> = isRespanModel
    ? {
        buy_signal: {
          type: 'noul',
          instructions:
            'Should the trader open a BUY (LONG) XAU/USD position right now based on S/R structure, price action, and order flow?',
          criteria: {
            true: 'Bullish structure, strong Support bounce/rejection, or valid upside breakout with sufficient room before nearest Resistance and >80% scalp winrate quality.',
            false: 'Bearish, choppy, ranging, or blocked by nearby resistance.',
          },
        },
        sell_signal: {
          type: 'noul',
          instructions:
            'Should the trader open a SELL (SHORT) XAU/USD position right now based on S/R structure, price action, and order flow?',
          criteria: {
            true: 'Bearish structure, strong Resistance rejection, or valid downside breakdown with sufficient room before nearest Support and >80% scalp winrate quality.',
            false: 'Bullish, choppy, ranging, or blocked by nearby support.',
          },
        },
        hold_wait: {
          type: 'noul',
          instructions:
            'Should the trader HOLD / WAIT and avoid opening a new XAU/USD trade right now?',
          criteria: {
            true: 'Market is choppy or ranging, pinned near S/R barrier without confirmation, post-TP pullback/exhaustion, or unfavorable risk-reward.',
            false: 'Clean high-conviction directional BUY or SELL setup is confirmed.',
          },
        },
        bullish_bias: {
          type: 'noul',
          instructions: 'Is the dominant structural market bias on the active XAU/USD timeframe BULLISH?',
          criteria: {
            true: 'Higher highs and higher lows, bullish BOS, or demand absorption dominates.',
            false: 'Bearish structure or sideways ranging dominates.',
          },
        },
        bearish_bias: {
          type: 'noul',
          instructions: 'Is the dominant structural market bias on the active XAU/USD timeframe BEARISH?',
          criteria: {
            true: 'Lower highs and lower lows, bearish BOS, or supply rejection dominates.',
            false: 'Bullish structure or sideways ranging dominates.',
          },
        },
        high_conviction: {
          type: 'noul',
          instructions:
            'Does this setup carry high institutional conviction with clean S/R alignment and tight scalp risk?',
          criteria: {
            true: 'Multi-timeframe bias, S/R clearance, and candlestick confirmation strongly agree.',
            false: 'Mixed signals, low ADX, or uncertain structure.',
          },
        },
      }
    : {
        signal: {
          type: 'choice',
          instructions:
            'Autonomous XAU/USD trading decision based primarily on Support/Resistance map, market structure, chart/candlestick patterns, order flow, and price action (indicators are optional only). Do not blindly reverse immediately after a TP hit.',
          criteria: {
            BUY: 'Bullish structure, strong Support bounce/rejection, or valid upside breakout with sufficient room before nearest Resistance.',
            SELL: 'Bearish structure, strong Resistance rejection, or valid downside breakdown with sufficient room before nearest Support.',
            HOLD: 'Price pinned near S/R barrier without confirmation, choppy/ranging, post-TP pullback/exhaustion, or unfavorable risk-reward.',
          },
        },
        market_bias: {
          type: 'choice',
          instructions: 'Dominant structural market bias on the active XAU/USD timeframe.',
          criteria: {
            BULLISH: 'Higher highs and higher lows, bullish BOS, or demand absorption.',
            BEARISH: 'Lower highs and lower lows, bearish BOS, or supply rejection.',
            RANGING: 'Sideways compression, overlapping bars, or balanced range.',
          },
        },
        conviction: {
          type: 'score',
          instructions: 'Confidence strength of the trading decision from uncertain to highest conviction.',
          criteria: [
            'Low certainty / wait (52%)',
            'Moderate setup (64%)',
            'Good S/R & pattern alignment (76%)',
            'High conviction breakout or rejection (86%)',
            'Maximum institutional confluence (94%)',
          ],
        },
        sl_atr_scale: {
          type: 'score',
          instructions: 'Appropriate Stop Loss buffer in ATR multiples beyond S/R invalidation.',
          criteria: [
            'Tight scalp buffer (0.85 ATR)',
            'Balanced S/R buffer (1.15 ATR)',
            'Standard structure buffer (1.50 ATR)',
            'Wide volatility buffer (2.00 ATR)',
          ],
        },
        tp_atr_scale: {
          type: 'score',
          instructions: 'Appropriate Take Profit 1 target distance in ATR multiples.',
          criteria: [
            'Quick scalp target (1.15 ATR)',
            'Standard S/R target (1.55 ATR)',
            'Momentum extension target (2.10 ATR)',
            'Breakout runner target (2.85 ATR)',
          ],
        },
      };

  if (openPositionsCount > 0) {
    if (isRespanModel) {
      questions.close_positions_now = {
        type: 'noul',
        instructions:
          'Should all currently open positions be closed immediately under strict AI Exit Judge rules?',
        criteria: {
          true: 'Win probability of reaching TP is BELOW 20% AND strong multi-candle price reversal against open positions is confirmed with >= 80% confidence.',
          false: 'Win probability >= 20% OR reversal confidence < 80%; keep position open.',
        },
      };
      questions.win_prob_healthy = {
        type: 'noul',
        instructions:
          'Do currently open positions still have at least 50% probability of reaching Take Profit?',
        criteria: {
          true: 'Trend structure and S/R clearance still support Take Profit.',
          false: 'Win probability has collapsed below 20%.',
        },
      };
      questions.reversal_confirmed = {
        type: 'noul',
        instructions:
          'Is there a high-confidence (>=80%) confirmed price reversal moving against open positions?',
        criteria: {
          true: 'Clear BOS/CHoCH multi-candle reversal against open trades.',
          false: 'Only minor pullback noise or trend remains intact.',
        },
      };
    } else {
      questions.position_decision = {
        type: 'choice',
        instructions:
          'Evaluate open positions (running without hard SL, TP active). STRICT RULE: KEEP unless win probability of reaching TP is BELOW 20% AND there is a confirmed price reversal indication against the position with at least 80% confidence.',
        criteria: {
          KEEP: 'Win probability >= 20% OR reversal confidence < 80%; keep open so TP can work.',
          CLOSE_BUY: 'Only if mixed positions and BUY win probability < 20% with >= 80% bearish reversal confidence.',
          CLOSE_SELL: 'Only if mixed positions and SELL win probability < 20% with >= 80% bullish reversal confidence.',
          CLOSE_ALL: 'Win probability is BELOW 20% AND strong multi-candle reversal against all open positions is indicated with >= 80% confidence; close all immediately.',
        },
      };
      questions.position_win_probability = {
        type: 'score',
        instructions: 'Estimated probability (0-100%) that currently open positions will still hit Take Profit.',
        criteria: [
          'Critical failure (< 20% win chance)',
          'Low chance (30% win chance)',
          'Moderate chance (50% win chance)',
          'Favorable chance (75% win chance)',
          'High chance (>= 90% win chance)',
        ],
      };
      questions.reversal_confidence = {
        type: 'score',
        instructions: 'Confidence (0-100%) that market structure is actively reversing against the open positions.',
        criteria: [
          'No reversal / trend intact (15%)',
          'Minor pullback noise (40%)',
          'Uncertain transition (65%)',
          'Strong reversal building (82%)',
          'Confirmed reversal against position (>= 92%)',
        ],
      };
    }
  }

  if (hasRecentClosedContext) {
    if (isRespanModel) {
      questions.post_tp_reentry = {
        type: 'noul',
        instructions:
          'After the recent TP/close, does clean directional momentum allow safe same-side re-entry?',
        criteria: {
          true: 'Trend continuation remains solid with clear room to next S/R.',
          false: 'Pullback, exhaustion, or trap detected after TP.',
        },
      };
    } else {
      questions.post_tp_evaluation = {
        type: 'choice',
        instructions:
          'Post-TP situational evaluation: decide whether trend continuation allows same-side re-entry or requires waiting/skipping without spontaneous counter-trend entry.',
        criteria: {
          RE_ENTRY_CONTINUATION:
            'Momentum remains clean and directional with room to next S/R; safe same-direction re-entry even if oscillator looks stretched.',
          WAIT_PULLBACK_HOLD:
            'Trend healthy but overextended or minor profit-taking pullback underway; wait with HOLD.',
          EXHAUSTION_SKIP:
            'Momentum fading, rejection wicks, or trap detected after TP; skip with HOLD.',
        },
      };
    }
  }

  const stateText = `${systemInstruction}\n\n${promptText}`;

  const callDecisions = async (withImage: boolean) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const statePayload =
      withImage && chartImageBase64
        ? [
            stateText,
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${chartImageBase64}`,
              },
            },
          ]
        : stateText;

    try {
      const res = await fetch(cfg.decisionsUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://aurumea.local',
          'X-Title': 'AurumEA XAUUSD M5',
        },
        body: JSON.stringify({
          model: activeDecisionModel,
          state: statePayload,
          questions,
        }),
      });

      const rawBody = await res.text();
      const trimmedBody = rawBody.trim();
      if (trimmedBody.startsWith('<')) {
        throw new OpenRouterError(
          res.status >= 400 ? res.status : 502,
          'Gateway OpenRouter merespon halaman non-JSON (kemungkinan timeout/restart gateway).'
        );
      }

      let parsed: Record<string, unknown> = {};
      try {
        parsed = trimmedBody ? (JSON.parse(trimmedBody) as Record<string, unknown>) : {};
      } catch {
        throw new OpenRouterError(
          res.status >= 400 ? res.status : 502,
          `Server OpenRouter merespon format non-JSON: ${trimmedBody.slice(0, 160)}`
        );
      }

      if (!res.ok) {
        const errObj = parsed.error as { message?: string; code?: number } | string | undefined;
        const detail =
          typeof errObj === 'string'
            ? errObj
            : errObj?.message ||
              (typeof parsed.message === 'string' ? parsed.message : '') ||
              (typeof parsed.detail === 'string' ? parsed.detail : '') ||
              trimmedBody.slice(0, 220) ||
              `HTTP ${res.status}`;
        throw new OpenRouterError(res.status, detail);
      }

      const answers = (parsed.answers ?? parsed.decisions ?? parsed.results) as
        | Record<string, Record<string, unknown>>
        | undefined;
      if (!answers || typeof answers !== 'object') {
        throw new OpenRouterError(
          502,
          `Respon Decisions API OpenRouter (${activeDecisionModel}) tidak memuat objek answers.`
        );
      }

      return answers;
    } catch (err) {
      if (err instanceof OpenRouterError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      throw new OpenRouterError(
        isAbort ? 408 : 502,
        isAbort ? `Timeout menghubungi OpenRouter (${activeDecisionModel}).` : msg
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let answers: Record<string, Record<string, unknown>> | null = null;
  let usedChartVision = Boolean(chartImageBase64) && !isRespanModel;

  if (chartImageBase64 && !isRespanModel) {
    try {
      answers = await callDecisions(true);
    } catch (err) {
      if (
        err instanceof OpenRouterError &&
        (err.statusCode === 400 || err.statusCode === 422)
      ) {
        usedChartVision = false;
        answers = await callDecisions(false);
      } else {
        throw err;
      }
    }
  } else {
    usedChartVision = false;
    answers = await callDecisions(false);
  }

  const pickChoice = <T extends string>(
    key: string,
    allowed: readonly T[],
    fallback: T
  ): { choice: T; prob: number; probsText: string } => {
    const ans = answers?.[key] || {};
    const probsRaw = ans.probabilities as Record<string, number> | undefined;
    let bestKey: string | undefined =
      typeof ans.choice === 'string'
        ? ans.choice
        : typeof ans.value === 'string'
        ? ans.value
        : typeof ans.selected === 'string'
        ? ans.selected
        : undefined;

    if ((!bestKey || !allowed.includes(bestKey.toUpperCase() as T)) && probsRaw) {
      let maxP = -1;
      for (const opt of allowed) {
        const p = Number(probsRaw[opt] ?? probsRaw[opt.toLowerCase()] ?? 0);
        if (p > maxP) {
          maxP = p;
          bestKey = opt;
        }
      }
    }

    const upper = String(bestKey || fallback).toUpperCase().trim() as T;
    const choice = allowed.includes(upper) ? upper : fallback;
    const probVal =
      Number(probsRaw?.[choice] ?? probsRaw?.[choice.toLowerCase()] ?? ans.confidence ?? ans.probability ?? 0.65);
    const probsText = probsRaw
      ? allowed
          .map(
            (opt) =>
              `${opt} ${Math.round(Number(probsRaw[opt] ?? probsRaw[opt.toLowerCase()] ?? 0) * 100)}%`
          )
          .join(' · ')
      : `${choice} ${Math.round(probVal * 100)}%`;

    return {
      choice,
      prob: Number.isFinite(probVal) ? Math.max(0, Math.min(1, probVal)) : 0.65,
      probsText,
    };
  };

  const pickScoreNorm = (key: string, count: number, fallbackNorm: number): number => {
    const ans = answers?.[key] || {};
    const arr = Array.isArray(ans.probabilities) ? ans.probabilities.map(Number) : null;
    if (arr && arr.length === count) {
      const total = arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      if (total > 0) {
        const expectedIdx = arr.reduce(
          (acc, p, idx) => acc + idx * (Number.isFinite(p) ? p : 0),
          0
        ) / total;
        return Math.max(0, Math.min(1, expectedIdx / Math.max(1, count - 1)));
      }
    }
    const rawScore = Number(ans.score ?? ans.value);
    if (Number.isFinite(rawScore)) {
      if (rawScore >= 0 && rawScore <= 1 && count > 2) return rawScore;
      return Math.max(0, Math.min(1, rawScore / Math.max(1, count - 1)));
    }
    return fallbackNorm;
  };

  const pickNoulYesProb = (key: string, fallbackProb: number): number => {
    const ans = (answers?.[key] || {}) as Record<string, unknown>;
    if (ans.noul !== undefined && Number.isFinite(Number(ans.noul))) {
      const nVal = Number(ans.noul);
      return Math.max(0, Math.min(1, nVal > 1 ? nVal / 100 : nVal));
    }
    const probs = ans.probabilities as Record<string, unknown> | undefined;
    if (probs && typeof probs === 'object') {
      const yesRaw = probs.true ?? probs.TRUE ?? probs.yes ?? probs.YES ?? probs['1'];
      if (yesRaw !== undefined && Number.isFinite(Number(yesRaw))) {
        return Math.max(0, Math.min(1, Number(yesRaw)));
      }
      const noRaw = probs.false ?? probs.FALSE ?? probs.no ?? probs.NO ?? probs['0'];
      if (noRaw !== undefined && Number.isFinite(Number(noRaw))) {
        return Math.max(0, Math.min(1, 1 - Number(noRaw)));
      }
    }
    const directProb = Number(ans.probability ?? ans.score ?? ans.confidence);
    const val = ans.value ?? ans.answer ?? ans.choice;
    if (Number.isFinite(directProb)) {
      const norm = directProb > 1 ? directProb / 100 : directProb;
      if (val === false || String(val).toLowerCase() === 'false' || String(val).toLowerCase() === 'no') {
        return Math.max(0, Math.min(1, norm > 0.5 ? 1 - norm : norm));
      }
      return Math.max(0, Math.min(1, norm));
    }
    if (val === true || String(val).toLowerCase() === 'true' || String(val).toLowerCase() === 'yes') {
      return 0.82;
    }
    if (val === false || String(val).toLowerCase() === 'false' || String(val).toLowerCase() === 'no') {
      return 0.18;
    }
    return fallbackProb;
  };

  let sig: { choice: 'BUY' | 'SELL' | 'HOLD'; prob: number; probsText: string };
  let bias: { choice: 'BULLISH' | 'BEARISH' | 'RANGING'; prob: number; probsText: string };
  let convNorm: number;
  let slNorm: number;
  let tpNorm: number;
  let posEvalRaw: {
    choice: 'NONE' | 'KEEP' | 'CLOSE_BUY' | 'CLOSE_SELL' | 'CLOSE_ALL';
    prob: number;
    probsText: string;
  };
  let winProbNorm: number;
  let revConfNorm: number;
  let postTpEval: {
    choice: 'NONE' | 'RE_ENTRY_CONTINUATION' | 'WAIT_PULLBACK_HOLD' | 'EXHAUSTION_SKIP';
    prob: number;
    probsText: string;
  };

  if (isRespanModel) {
    const pBuy = pickNoulYesProb('buy_signal', 0.2);
    const pSell = pickNoulYesProb('sell_signal', 0.2);
    const pHold = pickNoulYesProb('hold_wait', 0.6);
    const pSum = Math.max(0.001, pBuy + pSell + pHold);
    const nBuy = pBuy / pSum;
    const nSell = pSell / pSum;
    const nHold = pHold / pSum;

    let sigChoice: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let sigProb = nHold;
    if (nBuy >= nSell && nBuy >= nHold && pBuy >= 0.55) {
      sigChoice = 'BUY';
      sigProb = nBuy;
    } else if (nSell > nBuy && nSell >= nHold && pSell >= 0.55) {
      sigChoice = 'SELL';
      sigProb = nSell;
    }
    sig = {
      choice: sigChoice,
      prob: Math.max(0.5, sigProb),
      probsText: `BUY ${Math.round(nBuy * 100)}% · SELL ${Math.round(nSell * 100)}% · HOLD ${Math.round(nHold * 100)}%`,
    };

    const pBull = pickNoulYesProb('bullish_bias', 0.35);
    const pBear = pickNoulYesProb('bearish_bias', 0.35);
    const pRange = Math.max(0.1, 1 - Math.max(pBull, pBear));
    const bSum = Math.max(0.001, pBull + pBear + pRange);
    const nBull = pBull / bSum;
    const nBear = pBear / bSum;
    const nRange = pRange / bSum;
    const biasChoice: 'BULLISH' | 'BEARISH' | 'RANGING' =
      nBull >= nBear && nBull >= nRange
        ? 'BULLISH'
        : nBear > nBull && nBear >= nRange
        ? 'BEARISH'
        : 'RANGING';
    bias = {
      choice: biasChoice,
      prob: biasChoice === 'BULLISH' ? nBull : biasChoice === 'BEARISH' ? nBear : nRange,
      probsText: `BULLISH ${Math.round(nBull * 100)}% · BEARISH ${Math.round(nBear * 100)}% · RANGING ${Math.round(nRange * 100)}%`,
    };

    const pConv = pickNoulYesProb('high_conviction', 0.55);
    convNorm =
      sig.choice === 'HOLD'
        ? Math.max(0.45, Math.min(0.95, Math.max(pConv, sig.prob * 0.85)))
        : Math.max(0.25, Math.min(0.95, pConv));
    slNorm = isScalpMode ? 0.35 : 0.6;
    tpNorm = isScalpMode ? 0.45 : 0.6;

    if (openPositionsCount > 0) {
      const pClose = pickNoulYesProb('close_positions_now', 0.15);
      const pWin = pickNoulYesProb('win_prob_healthy', 0.65);
      const pRev = pickNoulYesProb('reversal_confirmed', 0.25);
      winProbNorm = pWin;
      revConfNorm = pRev;
      const closeChoice: 'KEEP' | 'CLOSE_ALL' =
        pClose >= 0.7 && pWin < 0.2 && pRev >= 0.8 ? 'CLOSE_ALL' : 'KEEP';
      posEvalRaw = {
        choice: closeChoice,
        prob: closeChoice === 'CLOSE_ALL' ? pClose : 1 - pClose,
        probsText: `KEEP ${Math.round((1 - pClose) * 100)}% · CLOSE_ALL ${Math.round(pClose * 100)}%`,
      };
    } else {
      posEvalRaw = { choice: 'NONE', prob: 1, probsText: '' };
      winProbNorm = 1;
      revConfNorm = 0;
    }

    if (hasRecentClosedContext) {
      const pRe = pickNoulYesProb('post_tp_reentry', 0.35);
      const pChoice: 'RE_ENTRY_CONTINUATION' | 'WAIT_PULLBACK_HOLD' =
        pRe >= 0.65 ? 'RE_ENTRY_CONTINUATION' : 'WAIT_PULLBACK_HOLD';
      postTpEval = {
        choice: pChoice,
        prob: pChoice === 'RE_ENTRY_CONTINUATION' ? pRe : 1 - pRe,
        probsText: `RE_ENTRY ${Math.round(pRe * 100)}% · WAIT_PULLBACK ${Math.round((1 - pRe) * 100)}%`,
      };
    } else {
      postTpEval = { choice: 'NONE', prob: 1, probsText: '' };
    }
  } else {
    sig = pickChoice('signal', ['BUY', 'SELL', 'HOLD'] as const, 'HOLD');
    bias = pickChoice('market_bias', ['BULLISH', 'BEARISH', 'RANGING'] as const, 'RANGING');
    convNorm = pickScoreNorm('conviction', 5, 0.55);
    slNorm = pickScoreNorm('sl_atr_scale', 4, isScalpMode ? 0.35 : 0.6);
    tpNorm = pickScoreNorm('tp_atr_scale', 4, isScalpMode ? 0.35 : 0.55);

    posEvalRaw =
      openPositionsCount > 0
        ? pickChoice(
            'position_decision',
            ['KEEP', 'CLOSE_BUY', 'CLOSE_SELL', 'CLOSE_ALL'] as const,
            'KEEP'
          )
        : { choice: 'NONE' as const, prob: 1, probsText: '' };

    winProbNorm =
      openPositionsCount > 0 ? pickScoreNorm('position_win_probability', 5, 0.55) : 1;
    revConfNorm =
      openPositionsCount > 0 ? pickScoreNorm('reversal_confidence', 5, 0.25) : 0;

    postTpEval = hasRecentClosedContext
      ? pickChoice(
          'post_tp_evaluation',
          ['RE_ENTRY_CONTINUATION', 'WAIT_PULLBACK_HOLD', 'EXHAUSTION_SKIP'] as const,
          'WAIT_PULLBACK_HOLD'
        )
      : { choice: 'NONE' as const, prob: 1, probsText: '' };
  }

  const winProbability =
    openPositionsCount > 0 ? Math.max(0, Math.min(100, Math.round(winProbNorm * 100))) : undefined;
  const reversalConfidence =
    openPositionsCount > 0 ? Math.max(0, Math.min(100, Math.round(revConfNorm * 100))) : undefined;

  const posExitAllowed =
    openPositionsCount > 0 &&
    winProbability !== undefined &&
    reversalConfidence !== undefined &&
    winProbability < 20 &&
    reversalConfidence >= 80;

  const posEval =
    openPositionsCount > 0
      ? posEvalRaw.choice !== 'KEEP' && !posExitAllowed
        ? { ...posEvalRaw, choice: 'KEEP' as const }
        : posEvalRaw
      : posEvalRaw;

  const confidence = Math.max(
    45,
    Math.min(96, Math.round((52 + convNorm * 42) * 0.55 + sig.prob * 100 * 0.45))
  );

  const entryPrice =
    sig.choice === 'BUY'
      ? snapshot.quote.ask
      : sig.choice === 'SELL'
      ? snapshot.quote.bid
      : snapshot.quote.mid;

  const slAtrMult = 0.85 + slNorm * 1.15;
  const tp1AtrMult = 1.15 + tpNorm * 1.6;
  const tp2AtrMult = tp1AtrMult * 1.65;

  let stopLoss =
    sig.choice === 'SELL'
      ? entryPrice + atrValue * slAtrMult
      : entryPrice - atrValue * slAtrMult;
  let takeProfit1 =
    sig.choice === 'SELL'
      ? entryPrice - atrValue * tp1AtrMult
      : entryPrice + atrValue * tp1AtrMult;
  let takeProfit2 =
    sig.choice === 'SELL'
      ? entryPrice - atrValue * tp2AtrMult
      : entryPrice + atrValue * tp2AtrMult;

  const nearSup = chartStructure.nearestSupport;
  const nearRes = chartStructure.nearestResistance;
  if (sig.choice === 'BUY') {
    if (nearSup && nearSup.price < entryPrice && entryPrice - nearSup.price <= atrValue * 2.4) {
      stopLoss = nearSup.price - atrValue * 0.25;
    }
    if (nearRes && nearRes.price > entryPrice + atrValue * 0.75 && nearRes.price - entryPrice <= atrValue * 3.2) {
      takeProfit1 = nearRes.price - atrValue * 0.12;
      if (takeProfit2 <= takeProfit1) takeProfit2 = takeProfit1 + atrValue * 0.9;
    }
  } else if (sig.choice === 'SELL') {
    if (nearRes && nearRes.price > entryPrice && nearRes.price - entryPrice <= atrValue * 2.4) {
      stopLoss = nearRes.price + atrValue * 0.25;
    }
    if (nearSup && nearSup.price < entryPrice - atrValue * 0.75 && entryPrice - nearSup.price <= atrValue * 3.2) {
      takeProfit1 = nearSup.price + atrValue * 0.12;
      if (takeProfit2 >= takeProfit1) takeProfit2 = takeProfit1 - atrValue * 0.9;
    }
  }

  stopLoss = Number(stopLoss.toFixed(2));
  takeProfit1 = Number(takeProfit1.toFixed(2));
  takeProfit2 = Number(takeProfit2.toFixed(2));

  const slDist = Math.max(0.1, Math.abs(entryPrice - stopLoss));
  const tpDist = Math.max(0.1, Math.abs(takeProfit1 - entryPrice));
  const rr = `1:${(tpDist / slDist).toFixed(1)}`;

  const keyLevelsSummary = `${chartStructure.marketStructure} (${chartStructure.structureSummary}) | ${chartStructure.pricePositionNote}${
    chartStructure.chartPatterns[0] ? ` | Pola: ${chartStructure.chartPatterns[0]}` : ''
  }`;

  const patternDesc =
    chartStructure.candlestickPatterns[0] ||
    chartStructure.chartPatterns[0] ||
    `Decisions ${bias.choice} (${sig.choice})`;

  const highProbTpDist = Math.max(0.45, Math.min(atrValue * 0.65, tpDist * 0.65));
  const rawHighProbTp =
    sig.choice === 'SELL'
      ? Number((snapshot.quote.bid - highProbTpDist).toFixed(2))
      : Number((snapshot.quote.ask + highProbTpDist).toFixed(2));

  const synthesized = {
    signal: sig.choice,
    confidence,
    marketBias: bias.choice,
    positionDecision: posEval.choice,
    positionReason:
      openPositionsCount > 0
        ? `OpenRouter Decider (${Math.round(posEval.prob * 100)}%): ${posEval.choice} (${posEval.probsText}) · Peluang Win: ${winProbability}% · Keyakinan Balik Arah: ${reversalConfidence}%.`
        : 'Tidak ada posisi terbuka saat ini.',
    winProbability,
    reversalConfidence,
    highProbTp: rawHighProbTp,
    highProbTpConfidence: 88,
    postTpEvaluation: postTpEval.choice,
    postTpReason: hasRecentClosedContext
      ? `Evaluasi pasca-TP OpenRouter Decider (${Math.round(postTpEval.prob * 100)}%): ${postTpEval.choice} (${postTpEval.probsText}).`
      : 'Tidak ada konteks pasca-TP aktif.',
    keyLevelsSummary,
    judgeVerdict: `VONIS DECIDER: ${sig.choice} (${confidence}%) — Probabilitas [${sig.probsText}]`,
    indicatorWeighting: `Probabilitas OpenRouter Decisions: Bias ${bias.probsText} | S/R & Price Action sebagai bobot utama, indikator hanya penunjang.`,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2,
    riskRewardRatio: rr,
    setupPattern: patternDesc.slice(0, 64),
    summary: `OpenRouter ${activeDecisionModel} menilai struktur ${chartStructure.marketStructure} dengan distribusi keputusan [${sig.probsText}] dan bias [${bias.probsText}]. ${chartStructure.pricePositionNote}`,
    keyFactors: [
      `Distribusi Keputusan: ${sig.probsText}`,
      `Bias Struktur: ${bias.probsText}`,
      `Support/Resistance: ${
        nearSup ? `S1 ${nearSup.price.toFixed(2)}` : 'No S1'
      } / ${nearRes ? `R1 ${nearRes.price.toFixed(2)}` : 'No R1'}`,
      `Target ATR: SL ${slAtrMult.toFixed(2)}x ATR · TP1 ${tp1AtrMult.toFixed(2)}x ATR (${rr})`,
    ],
    invalidatedIf:
      sig.choice === 'BUY'
        ? `Break dan close kuat di bawah support ${stopLoss.toFixed(2)}`
        : sig.choice === 'SELL'
        ? `Break dan close kuat di atas resistance ${stopLoss.toFixed(2)}`
        : 'Terbentuk breakout/breakdown terkonfirmasi melewati S1/R1 terdekat',
  };

  return {
    rawText: JSON.stringify(synthesized),
    model: `openrouter/${activeDecisionModel}`,
    usedChartVision,
  };
}

// ---------- Deep Learning & Quantitative Sequence Pattern Engine (220 Candles) ----------

function buildDeepLearningTelemetry(candles: Candle[], atr: number): string {
  if (candles.length < 30) {
    return 'Data candle belum mencukupi untuk ekstraksi fitur Deep Learning.';
  }
  const safeAtr = Math.max(0.2, atr);
  const n = candles.length;
  const last = candles[n - 1];

  const ret = (bars: number) => {
    const idx = Math.max(0, n - 1 - bars);
    const diff = last.close - candles[idx].close;
    const z = diff / safeAtr;
    return `${diff >= 0 ? '+' : ''}${diff.toFixed(2)} USD (Z=${z >= 0 ? '+' : ''}${z.toFixed(2)} ATR)`;
  };

  // Kaufman Efficiency Ratio (14 & 30 bars): |NetMove| / Sum(|StepMoves|)
  const calcEfficiency = (len: number) => {
    const slice = candles.slice(-len);
    const net = Math.abs(slice[slice.length - 1].close - slice[0].close);
    let path = 0;
    for (let i = 1; i < slice.length; i++) {
      path += Math.abs(slice[i].close - slice[i - 1].close);
    }
    return path > 0 ? net / path : 0;
  };
  const er14 = calcEfficiency(14);
  const er30 = calcEfficiency(30);
  const erRegime =
    er14 >= 0.45 ? 'TRENDING KUAT' : er14 <= 0.2 ? 'SIDEWAYS / CHOPPY' : 'TRANSISI / PULLBACK';

  // Linear Regression Slope (10-bar & 20-bar) + Acceleration
  const calcSlope = (slice: Candle[]) => {
    const m = slice.length;
    if (m < 2) return 0;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < m; i++) {
      sumX += i;
      sumY += slice[i].close;
      sumXY += i * slice[i].close;
      sumXX += i * i;
    }
    const denom = m * sumXX - sumX * sumX;
    return denom !== 0 ? (m * sumXY - sumX * sumY) / denom : 0;
  };
  const slope10 = calcSlope(candles.slice(-10));
  const slope20 = calcSlope(candles.slice(-20));
  const slopeRecent5 = calcSlope(candles.slice(-5));
  const slopePrev5 = calcSlope(candles.slice(-10, -5));
  const accel = slopeRecent5 - slopePrev5;

  // Volatility Regime (ATR14 vs 50-bar mean true range)
  const tr50: number[] = [];
  const startTr = Math.max(1, n - 50);
  for (let i = startTr; i < n; i++) {
    const cur = candles[i];
    const prevC = candles[i - 1].close;
    tr50.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prevC), Math.abs(cur.low - prevC))
    );
  }
  const meanTr50 = tr50.length > 0 ? tr50.reduce((a, b) => a + b, 0) / tr50.length : safeAtr;
  const volRatio = meanTr50 > 0 ? safeAtr / meanTr50 : 1;
  const volRegime =
    volRatio >= 1.25
      ? 'EKSPANSI VOLATILITAS'
      : volRatio <= 0.8
      ? 'KOMPRESI / SQUEEZE'
      : 'VOLATILITAS NORMAL';

  // Order Flow Body & Wick Imbalance (last 10 candles)
  let bullFlow = 0;
  let bearFlow = 0;
  let upperWickSum = 0;
  let lowerWickSum = 0;
  for (const c of candles.slice(-10)) {
    const body = c.close - c.open;
    if (body >= 0) bullFlow += body;
    else bearFlow += Math.abs(body);
    upperWickSum += c.high - Math.max(c.open, c.close);
    lowerWickSum += Math.min(c.open, c.close) - c.low;
  }
  const totalFlow = bullFlow + bearFlow;
  const buyPressurePct = totalFlow > 0 ? (bullFlow / totalFlow) * 100 : 50;

  // k-NN 5-Candle Feature Sequence Matching across available history (cosine similarity)
  const buildWindowVec = (win: Candle[]): number[] => {
    const vec: number[] = [];
    for (const c of win) {
      const range = Math.max(0.05, c.high - c.low);
      const body = (c.close - c.open) / safeAtr;
      const uw = (c.high - Math.max(c.open, c.close)) / range;
      const lw = (Math.min(c.open, c.close) - c.low) / range;
      vec.push(body, uw, lw);
    }
    return vec;
  };
  const cosineSim = (a: number[], b: number[]) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };

  const queryVec = buildWindowVec(candles.slice(-5));
  const matches: Array<{ sim: number; fwd1: number; fwd3: number }> = [];
  for (let i = 0; i <= n - 10; i++) {
    const candidateVec = buildWindowVec(candles.slice(i, i + 5));
    const sim = cosineSim(queryVec, candidateVec);
    const endClose = candles[i + 4].close;
    const fwd1 = candles[i + 5].close - endClose;
    const fwd3 = candles[i + 7].close - endClose;
    matches.push({ sim, fwd1, fwd3 });
  }
  matches.sort((a, b) => b.sim - a.sim);
  const topK = matches.slice(0, 5);
  const bullFwd3 = topK.filter((m) => m.fwd3 > 0).length;
  const avgFwd3 =
    topK.length > 0 ? topK.reduce((acc, m) => acc + m.fwd3, 0) / topK.length : 0;
  const avgSim =
    topK.length > 0 ? (topK.reduce((acc, m) => acc + m.sim, 0) / topK.length) * 100 : 0;

  return [
    `- Vektor Momentum Multi-Horizon: 1-Bar=${ret(1)} | 3-Bar=${ret(3)} | 6-Bar=${ret(6)} | 12-Bar=${ret(12)} | 24-Bar=${ret(24)}`,
    `- Regresi Linear & Akselerasi: Slope10=${slope10 >= 0 ? '+' : ''}${slope10.toFixed(2)} USD/bar | Slope20=${slope20 >= 0 ? '+' : ''}${slope20.toFixed(2)} | Akselerasi 5-bar=${accel >= 0 ? '+' : ''}${accel.toFixed(2)}`,
    `- Efisiensi Arah (Kaufman ER): ER14=${er14.toFixed(2)} | ER30=${er30.toFixed(2)} -> Rezim: ${erRegime}`,
    `- Rezim Volatilitas: Rasio ATR14/Mean50 = ${volRatio.toFixed(2)}x -> ${volRegime}`,
    `- Order Flow & Likuiditas (10 Candle): Dominasi Buyer Body=${buyPressurePct.toFixed(1)}% vs Seller=${(100 - buyPressurePct).toFixed(1)}% | Total Ekor Atas=${upperWickSum.toFixed(2)} USD vs Ekor Bawah=${lowerWickSum.toFixed(2)} USD`,
    `- Memori Pola Sekuensial k-NN (${n} Candle): Top-5 pola 5-candle termirip (kemiripan rata-rata ${avgSim.toFixed(1)}%) menghasilkan ${bullFwd3}/5 lanjutan BULLISH dalam 3 candle berikutnya dengan rata-rata perubahan ${avgFwd3 >= 0 ? '+' : ''}${avgFwd3.toFixed(2)} USD.`,
  ].join('\n');
}

// ---------- Live XAU/USD Multi-Timeframe Market Data Engine ----------

interface RawFeedResult {
  candles: Candle[];
  bid: number;
  ask: number;
  mid: number;
  high24h: number;
  low24h: number;
  change24h: number;
  changePercent24h: number;
  source: string;
  marketStatus: 'LIVE' | 'DELAYED';
}

const spotCacheByTf = new Map<ChartTimeframe, { snapshot: MarketSnapshot; fetchedAt: number }>();
const activeSpotFetchByTf = new Map<ChartTimeframe, Promise<MarketSnapshot>>();

function alignToM5(unixSeconds: number): number {
  return Math.floor(unixSeconds / 300) * 300;
}

function alignToTimeframe(unixSeconds: number, tfSeconds: number): number {
  return Math.floor(unixSeconds / tfSeconds) * tfSeconds;
}

function normalizeTimeframe(raw: unknown): ChartTimeframe {
  const val = String(raw || '').toUpperCase().trim() as ChartTimeframe;
  return val in TIMEFRAME_META ? val : 'M5';
}

function normalizeBrokerId(raw: unknown): BrokerFeedId {
  const val = String(raw || '').toUpperCase().trim() as BrokerFeedId;
  return BROKER_FEEDS.some((b) => b.id === val) ? val : 'PEPPERSTONE';
}

function resampleCandlesToTimeframe(candles: Candle[], timeframe: ChartTimeframe): Candle[] {
  const tfSec = TIMEFRAME_META[timeframe].seconds;
  if (tfSec <= 300) return candles;
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const bucketTime = alignToTimeframe(c.time, tfSec);
    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, { ...c, time: bucketTime });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

// ---------- Real-Time TradingView Broker WebSocket Engine ----------

interface TvStreamState {
  streamKey: string;
  brokerId: BrokerFeedId;
  timeframe: ChartTimeframe;
  brokerName: string;
  tvSymbol: string;
  ws: WebSocket | null;
  candlesByIndex: Map<number, Candle>;
  lp: number | null;
  bid: number | null;
  ask: number | null;
  prevClose: number | null;
  high24h: number | null;
  low24h: number | null;
  ch: number | null;
  chp: number | null;
  seriesCompleted: boolean;
  lastQuoteTickAt: number;
  lastAccessedAt: number;
  connectingPromise: Promise<void> | null;
  destroyed: boolean;
}

const tvStreams = new Map<string, TvStreamState>();

function packTvMessage(method: string, params: unknown[]): string {
  const json = JSON.stringify({ m: method, p: params });
  return `~m~${json.length}~m~${json}`;
}

function getOrStartTvStream(brokerId: BrokerFeedId, timeframe: ChartTimeframe): TvStreamState {
  const meta = BROKER_FEEDS.find((b) => b.id === brokerId);
  if (!meta || !meta.tvSymbol) {
    throw new Error(`Broker ${brokerId} tidak memiliki simbol TradingView.`);
  }

  const tfMeta = TIMEFRAME_META[timeframe];
  const streamKey = `${brokerId}:${timeframe}`;
  const existing = tvStreams.get(streamKey);
  if (existing && !existing.destroyed && existing.ws && existing.ws.readyState !== WebSocket.CLOSED) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const state: TvStreamState = {
    streamKey,
    brokerId,
    timeframe,
    brokerName: meta.name,
    tvSymbol: meta.tvSymbol,
    ws: null,
    candlesByIndex: new Map<number, Candle>(),
    lp: null,
    bid: null,
    ask: null,
    prevClose: null,
    high24h: null,
    low24h: null,
    ch: null,
    chp: null,
    seriesCompleted: false,
    lastQuoteTickAt: 0,
    lastAccessedAt: Date.now(),
    connectingPromise: null,
    destroyed: false,
  };
  tvStreams.set(streamKey, state);

  state.connectingPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`Timeout menyambung ke feed broker ${meta.name} (${meta.tvSymbol}).`));
      }
    }, 7000);

    const wsOptions = { headers: { Origin: 'https://www.tradingview.com' } };
    const ws = new WebSocket(
      'wss://data.tradingview.com/socket.io/websocket',
      wsOptions as unknown as string[]
    );
    state.ws = ws;

    const chartSession = `cs_${brokerId}_${timeframe}_${Math.random().toString(36).slice(2, 7)}`;
    const quoteSession = `qs_${brokerId}_${timeframe}_${Math.random().toString(36).slice(2, 7)}`;

    ws.onopen = () => {
      ws.send(packTvMessage('set_auth_token', ['unauthorized_user_token']));
      ws.send(packTvMessage('quote_create_session', [quoteSession]));
      ws.send(
        packTvMessage('quote_set_fields', [
          quoteSession,
          'lp',
          'bid',
          'ask',
          'ch',
          'chp',
          'high_price',
          'low_price',
          'prev_close_price',
        ])
      );
      ws.send(packTvMessage('quote_add_symbols', [quoteSession, meta.tvSymbol!]));
      ws.send(packTvMessage('chart_create_session', [chartSession, '']));
      ws.send(
        packTvMessage('resolve_symbol', [
          chartSession,
          'sds_sym_1',
          '=' + JSON.stringify({ symbol: meta.tvSymbol, adjustment: 'splits' }),
        ])
      );
      ws.send(
        packTvMessage('create_series', [
          chartSession,
          'sds_1',
          's1',
          'sds_sym_1',
          tfMeta.tvResolution,
          220,
        ])
      );
    };

    const ingestBars = (arr: unknown) => {
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        const bar = item as { i?: number; v?: number[] };
        if (typeof bar?.i !== 'number' || !Array.isArray(bar?.v) || bar.v.length < 5) continue;
        const [rawTime, o, h, l, c, vol] = bar.v;
        if (
          typeof rawTime !== 'number' ||
          typeof o !== 'number' ||
          typeof h !== 'number' ||
          typeof l !== 'number' ||
          typeof c !== 'number'
        ) {
          continue;
        }
        state.candlesByIndex.set(bar.i, {
          time: alignToTimeframe(Math.floor(rawTime), tfMeta.seconds),
          open: Number(o.toFixed(2)),
          high: Number(h.toFixed(2)),
          low: Number(l.toFixed(2)),
          close: Number(c.toFixed(2)),
          volume: Number(vol ?? 100),
        });
      }
    };

    ws.onmessage = (ev) => {
      const text = String(ev.data);
      const packets = text.split(/~m~\d+~m~/).filter(Boolean);
      for (const pkt of packets) {
        if (pkt.startsWith('~h~')) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(`~m~${pkt.length}~m~${pkt}`);
          }
          continue;
        }
        if (!pkt.startsWith('{')) continue;

        let msg: { m?: string; p?: unknown[] };
        try {
          msg = JSON.parse(pkt) as { m?: string; p?: unknown[] };
        } catch {
          continue;
        }

        if (msg.m === 'timescale_update' || msg.m === 'du') {
          const payload = msg.p?.[1] as { sds_1?: { s?: unknown[] } } | undefined;
          if (payload?.sds_1?.s) {
            ingestBars(payload.sds_1.s);
          }
        } else if (msg.m === 'qsd') {
          const q = msg.p?.[1] as {
            s?: string;
            v?: {
              lp?: number;
              bid?: number;
              ask?: number;
              ch?: number;
              chp?: number;
              high_price?: number;
              low_price?: number;
              prev_close_price?: number;
            };
          };
          if (q?.s === 'ok' && q.v) {
            state.lastQuoteTickAt = Date.now();
            if (typeof q.v.lp === 'number' && q.v.lp > 0) state.lp = Number(q.v.lp.toFixed(2));
            if (typeof q.v.bid === 'number' && q.v.bid > 0) state.bid = Number(q.v.bid.toFixed(2));
            if (typeof q.v.ask === 'number' && q.v.ask > 0) state.ask = Number(q.v.ask.toFixed(2));
            if (typeof q.v.ch === 'number') state.ch = Number(q.v.ch.toFixed(2));
            if (typeof q.v.chp === 'number') state.chp = Number(q.v.chp.toFixed(2));
            if (typeof q.v.high_price === 'number' && q.v.high_price > 0) {
              state.high24h = Number(q.v.high_price.toFixed(2));
            }
            if (typeof q.v.low_price === 'number' && q.v.low_price > 0) {
              state.low24h = Number(q.v.low_price.toFixed(2));
            }
            if (typeof q.v.prev_close_price === 'number' && q.v.prev_close_price > 0) {
              state.prevClose = Number(q.v.prev_close_price.toFixed(2));
            }
          }
        } else if (msg.m === 'series_completed') {
          state.seriesCompleted = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            // Give quote ticks ~250ms to arrive if bid/ask weren't in first frame
            setTimeout(() => resolve(), 250);
          }
        } else if (msg.m === 'symbol_error' || msg.m === 'series_error') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Simbol broker ${meta.tvSymbol} gagal dimuat.`));
          }
        }
      }
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Koneksi WebSocket ke ${meta.name} terputus.`));
      }
    };

    ws.onclose = () => {
      state.destroyed = true;
      if (tvStreams.get(streamKey) === state) {
        tvStreams.delete(streamKey);
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Stream broker ${meta.name} tertutup sebelum data siap.`));
      }
    };
  });

  return state;
}

// Idle cleanup for unused broker WebSockets every 15s
setInterval(() => {
  const now = Date.now();
  for (const [id, st] of tvStreams.entries()) {
    if (now - st.lastAccessedAt > 45000) {
      st.destroyed = true;
      try {
        st.ws?.close();
      } catch {
        // Ignore
      }
      tvStreams.delete(id);
    }
  }
}, 15000);

async function getTradingViewBrokerSnapshot(
  brokerId: BrokerFeedId,
  timeframe: ChartTimeframe
): Promise<MarketSnapshot> {
  const tfMeta = TIMEFRAME_META[timeframe];
  const state = getOrStartTvStream(brokerId, timeframe);
  if (!state.seriesCompleted && state.connectingPromise) {
    await state.connectingPromise;
  }

  // Deduplicate by aligned timeframe timestamp keeping the latest bar
  const dedup = new Map<number, Candle>();
  const ordered = Array.from(state.candlesByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map((e) => e[1]);
  for (const c of ordered) {
    dedup.set(c.time, c);
  }
  const candles = Array.from(dedup.values())
    .sort((a, b) => a.time - b.time)
    .slice(-220);

  if (candles.length < 20) {
    throw new Error(`Data candle ${timeframe} dari ${state.brokerName} belum mencukupi.`);
  }

  const last = candles[candles.length - 1];
  const rawBid = state.bid;
  const rawAsk = state.ask;
  const rawLp = state.lp ?? last.close;

  let bid: number;
  let ask: number;
  let mid: number;

  if (rawBid && rawAsk && rawAsk >= rawBid) {
    bid = rawBid;
    ask = rawAsk;
    mid = Number(((bid + ask) / 2).toFixed(2));
  } else {
    mid = Number(rawLp.toFixed(2));
    bid = Number((mid - 0.08).toFixed(2));
    ask = Number((mid + 0.08).toFixed(2));
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const currentBoundary = alignToTimeframe(nowSec, tfMeta.seconds);
  const candleCloseInSec = Math.max(0, currentBoundary + tfMeta.seconds - nowSec);
  const isFresh =
    nowSec - last.time < tfMeta.seconds * 3 || Date.now() - state.lastQuoteTickAt < 30000;

  if (isFresh && state.lp) {
    const tipPrice = state.lp;
    last.close = tipPrice;
    if (tipPrice > last.high) last.high = tipPrice;
    if (tipPrice < last.low) last.low = tipPrice;
  }

  const prevClose = state.prevClose ?? candles[0].open;
  const change24h =
    state.ch !== null ? state.ch : Number((mid - prevClose).toFixed(2));
  const changePercent24h =
    state.chp !== null
      ? state.chp
      : prevClose > 0
      ? Number(((change24h / prevClose) * 100).toFixed(2))
      : 0;

  const high24h =
    state.high24h !== null
      ? Math.max(state.high24h, ...candles.map((c) => c.high))
      : Number(Math.max(...candles.map((c) => c.high)).toFixed(2));
  const low24h =
    state.low24h !== null
      ? Math.min(state.low24h, ...candles.map((c) => c.low))
      : Number(Math.min(...candles.map((c) => c.low)).toFixed(2));

  const pack = buildIndicatorPack(candles);
  const quote: MarketQuote = {
    symbol: 'XAU/USD',
    timeframe,
    bid,
    ask,
    mid,
    spread: Number(Math.max(0, ask - bid).toFixed(2)),
    change24h,
    changePercent24h,
    high24h: Number(high24h.toFixed(2)),
    low24h: Number(low24h.toFixed(2)),
    source: `${state.brokerName} (${state.tvSymbol})`,
    brokerId,
    brokerSymbol: state.tvSymbol,
    marketStatus: nowSec - last.time < tfMeta.seconds * 3 ? 'LIVE' : 'DELAYED',
    updatedAt: Date.now(),
    candleCloseInSec,
  };

  return {
    quote,
    candles,
    indicators: pack.snapshot,
    ema9Series: pack.ema9Series,
    ema21Series: pack.ema21Series,
    ema50Series: pack.ema50Series,
    bbUpperSeries: pack.bbUpperSeries,
    bbLowerSeries: pack.bbLowerSeries,
  };
}

async function fetchYahooXau(
  symbol: 'XAUUSD=X' | 'GC=F',
  timeframe: ChartTimeframe
): Promise<RawFeedResult | null> {
  const tfMeta = TIMEFRAME_META[timeframe];
  const range = timeframe === 'H1' ? '1mo' : timeframe === 'M30' || timeframe === 'M15' ? '5d' : '2d';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=${tfMeta.yahooInterval}&range=${range}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AurumEA/1.0)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            regularMarketDayHigh?: number;
            regularMarketDayLow?: number;
          };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }>;
      };
    };

    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result.indicators?.quote?.[0]) return null;

    const ts = result.timestamp;
    const q = result.indicators.quote[0];
    const candles: Candle[] = [];

    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({
        time: alignToTimeframe(ts[i], tfMeta.seconds),
        open: Number(o.toFixed(2)),
        high: Number(h.toFixed(2)),
        low: Number(l.toFixed(2)),
        close: Number(c.toFixed(2)),
        volume: Number(v || 100),
      });
    }

    if (candles.length < 25) return null;

    const dedup = new Map<number, Candle>();
    for (const c of candles) dedup.set(c.time, c);
    const sorted = Array.from(dedup.values()).sort((a, b) => a.time - b.time);

    const last = sorted[sorted.length - 1];
    const metaPrice = result.meta?.regularMarketPrice;
    const mid = Number((metaPrice && metaPrice > 500 ? metaPrice : last.close).toFixed(2));
    last.close = mid;
    if (mid > last.high) last.high = mid;
    if (mid < last.low) last.low = mid;

    const halfSpread = 0.14;
    const bid = Number((mid - halfSpread).toFixed(2));
    const ask = Number((mid + halfSpread).toFixed(2));

    const barsPer24h = Math.max(1, Math.round(86400 / tfMeta.seconds));
    const prevClose =
      result.meta?.chartPreviousClose ??
      result.meta?.previousClose ??
      sorted[Math.max(0, sorted.length - barsPer24h)].open;
    const change24h = Number((mid - prevClose).toFixed(2));
    const changePercent24h = prevClose > 0 ? Number(((change24h / prevClose) * 100).toFixed(2)) : 0;

    const recent24h = sorted.slice(-barsPer24h);
    const high24h = Number(
      Math.max(result.meta?.regularMarketDayHigh ?? 0, ...recent24h.map((c) => c.high)).toFixed(2)
    );
    const low24h = Number(
      Math.min(
        result.meta?.regularMarketDayLow ?? 999999,
        ...recent24h.map((c) => c.low)
      ).toFixed(2)
    );

    const ageSec = Math.floor(Date.now() / 1000) - last.time;
    const isFresh = ageSec < tfMeta.seconds * 3;

    return {
      candles: sorted.slice(-220),
      bid,
      ask,
      mid,
      high24h,
      low24h,
      change24h,
      changePercent24h,
      source: symbol === 'XAUUSD=X' ? 'Spot XAU/USD (Yahoo Feed)' : 'COMEX Gold GC=F',
      marketStatus: isFresh ? 'LIVE' : 'DELAYED',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBinancePaxg(timeframe: ChartTimeframe): Promise<RawFeedResult | null> {
  const tfMeta = TIMEFRAME_META[timeframe];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const [klineRes, tickerRes] = await Promise.all([
      fetch(
        `https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=${tfMeta.binanceInterval}&limit=240`,
        { signal: controller.signal }
      ),
      fetch('https://data-api.binance.vision/api/v3/ticker/24hr?symbol=PAXGUSDT', {
        signal: controller.signal,
      }),
    ]);
    if (!klineRes.ok) return null;

    const rawKlines = (await klineRes.json()) as Array<
      [number, string, string, string, string, string, ...unknown[]]
    >;
    if (!Array.isArray(rawKlines) || rawKlines.length < 25) return null;

    const candles: Candle[] = rawKlines.map((k) => ({
      time: alignToTimeframe(Math.floor(k[0] / 1000), tfMeta.seconds),
      open: Number(Number(k[1]).toFixed(2)),
      high: Number(Number(k[2]).toFixed(2)),
      low: Number(Number(k[3]).toFixed(2)),
      close: Number(Number(k[4]).toFixed(2)),
      volume: Number(Number(k[5]).toFixed(2)),
    }));

    const last = candles[candles.length - 1];
    let bid = Number((last.close - 0.15).toFixed(2));
    let ask = Number((last.close + 0.15).toFixed(2));
    let mid = last.close;
    let high24h = Math.max(...candles.map((c) => c.high));
    let low24h = Math.min(...candles.map((c) => c.low));
    let change24h = 0;
    let changePercent24h = 0;

    if (tickerRes.ok) {
      const t = (await tickerRes.json()) as {
        bidPrice?: string;
        askPrice?: string;
        lastPrice?: string;
        highPrice?: string;
        lowPrice?: string;
        priceChange?: string;
        priceChangePercent?: string;
      };
      const b = Number(t.bidPrice);
      const a = Number(t.askPrice);
      const lp = Number(t.lastPrice);
      if (b > 0 && a > 0) {
        bid = Number(b.toFixed(2));
        ask = Number(a.toFixed(2));
        mid = Number(((b + a) / 2).toFixed(2));
      } else if (lp > 0) {
        mid = Number(lp.toFixed(2));
        bid = Number((mid - 0.15).toFixed(2));
        ask = Number((mid + 0.15).toFixed(2));
      }
      if (Number(t.highPrice) > 0) high24h = Number(Number(t.highPrice).toFixed(2));
      if (Number(t.lowPrice) > 0) low24h = Number(Number(t.lowPrice).toFixed(2));
      if (t.priceChange !== undefined) change24h = Number(Number(t.priceChange).toFixed(2));
      if (t.priceChangePercent !== undefined)
        changePercent24h = Number(Number(t.priceChangePercent).toFixed(2));
    }

    last.close = mid;
    if (mid > last.high) last.high = mid;
    if (mid < last.low) last.low = mid;

    return {
      candles: candles.slice(-220),
      bid,
      ask,
      mid,
      high24h,
      low24h,
      change24h,
      changePercent24h,
      source: 'PAXG/USD 24/7 Spot Gold',
      marketStatus: 'LIVE',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKrakenPaxg(timeframe: ChartTimeframe): Promise<RawFeedResult | null> {
  const tfMeta = TIMEFRAME_META[timeframe];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=${tfMeta.krakenInterval}`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
    };
    const key = Object.keys(json.result || {}).find((k) => k !== 'last');
    if (!key || !json.result?.[key]) return null;
    const rows = json.result[key];
    if (rows.length < 25) return null;

    const candles: Candle[] = rows.slice(-220).map((r) => ({
      time: alignToTimeframe(r[0], tfMeta.seconds),
      open: Number(Number(r[1]).toFixed(2)),
      high: Number(Number(r[2]).toFixed(2)),
      low: Number(Number(r[3]).toFixed(2)),
      close: Number(Number(r[4]).toFixed(2)),
      volume: Number(Number(r[6]).toFixed(2)),
    }));

    const last = candles[candles.length - 1];
    const first = candles[0];
    const mid = last.close;
    const change24h = Number((mid - first.open).toFixed(2));
    const changePercent24h =
      first.open > 0 ? Number(((change24h / first.open) * 100).toFixed(2)) : 0;

    return {
      candles,
      bid: Number((mid - 0.16).toFixed(2)),
      ask: Number((mid + 0.16).toFixed(2)),
      mid,
      high24h: Number(Math.max(...candles.map((c) => c.high)).toFixed(2)),
      low24h: Number(Math.min(...candles.map((c) => c.low)).toFixed(2)),
      change24h,
      changePercent24h,
      source: 'Kraken PAXG/USD Gold',
      marketStatus: 'LIVE',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadSpotFallbackFeed(timeframe: ChartTimeframe): Promise<MarketSnapshot> {
  const tfMeta = TIMEFRAME_META[timeframe];
  const spotXau = await fetchYahooXau('XAUUSD=X', timeframe);
  let chosen: RawFeedResult | null = null;

  if (spotXau && spotXau.marketStatus === 'LIVE') {
    chosen = spotXau;
  } else {
    const paxg = await fetchBinancePaxg(timeframe);
    if (paxg) {
      chosen = paxg;
    } else {
      const kraken = await fetchKrakenPaxg(timeframe);
      if (kraken) {
        chosen = kraken;
      } else {
        chosen = spotXau || (await fetchYahooXau('GC=F', timeframe));
      }
    }
  }

  if (!chosen) {
    throw new Error(
      `Gagal mengambil data pasar XAU/USD ${timeframe} real-time dari penyedia feed upstream.`
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const currentBoundary = alignToTimeframe(nowSec, tfMeta.seconds);
  const candleCloseInSec = Math.max(0, currentBoundary + tfMeta.seconds - nowSec);

  const pack = buildIndicatorPack(chosen.candles);
  const quote: MarketQuote = {
    symbol: 'XAU/USD',
    timeframe,
    bid: chosen.bid,
    ask: chosen.ask,
    mid: chosen.mid,
    spread: Number((chosen.ask - chosen.bid).toFixed(2)),
    change24h: chosen.change24h,
    changePercent24h: chosen.changePercent24h,
    high24h: chosen.high24h,
    low24h: chosen.low24h,
    source: chosen.source,
    brokerId: 'AUTO_SPOT',
    marketStatus: chosen.marketStatus,
    updatedAt: Date.now(),
    candleCloseInSec,
  };

  const snapshot: MarketSnapshot = {
    quote,
    candles: chosen.candles,
    indicators: pack.snapshot,
    ema9Series: pack.ema9Series,
    ema21Series: pack.ema21Series,
    ema50Series: pack.ema50Series,
    bbUpperSeries: pack.bbUpperSeries,
    bbLowerSeries: pack.bbLowerSeries,
  };

  spotCacheByTf.set(timeframe, { snapshot, fetchedAt: Date.now() });
  return snapshot;
}

async function getSpotFallbackSnapshot(
  timeframe: ChartTimeframe,
  forceRefresh = false
): Promise<MarketSnapshot> {
  const tfMeta = TIMEFRAME_META[timeframe];
  const cached = spotCacheByTf.get(timeframe);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 2000) {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentBoundary = alignToTimeframe(nowSec, tfMeta.seconds);
    cached.snapshot.quote.candleCloseInSec = Math.max(0, currentBoundary + tfMeta.seconds - nowSec);
    return cached.snapshot;
  }

  const existingPromise = activeSpotFetchByTf.get(timeframe);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = loadSpotFallbackFeed(timeframe).finally(() => {
    activeSpotFetchByTf.delete(timeframe);
  });
  activeSpotFetchByTf.set(timeframe, promise);
  return promise;
}

// Live MT5 feed snapshot pushed by the user's MT5 EA heartbeat
let mt5LiveSnapshot: MarketSnapshot | null = null;
let mt5LiveFeedUpdatedAt = 0;

async function getMarketSnapshot(
  brokerId: BrokerFeedId = 'PEPPERSTONE',
  timeframe: ChartTimeframe = 'M5',
  forceRefresh = false
): Promise<MarketSnapshot> {
  const tfMeta = TIMEFRAME_META[timeframe];

  if (brokerId === 'MT5_LIVE') {
    if (!mt5LiveSnapshot || Date.now() - mt5LiveFeedUpdatedAt > 60000) {
      throw new Error(
        'Terminal MT5 belum mengirim candle aktif. Jalankan EA AurumEA_XAUUSD_M5 di MT5 atau pilih broker seperti Pepperstone / Tickmill.'
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const currentBoundary = alignToTimeframe(nowSec, tfMeta.seconds);
    const closeIn = Math.max(0, currentBoundary + tfMeta.seconds - nowSec);

    if (timeframe === 'M5') {
      mt5LiveSnapshot.quote.candleCloseInSec = closeIn;
      return mt5LiveSnapshot;
    }

    const resampled = resampleCandlesToTimeframe(mt5LiveSnapshot.candles, timeframe);
    const pack = buildIndicatorPack(resampled);
    return {
      quote: {
        ...mt5LiveSnapshot.quote,
        timeframe,
        candleCloseInSec: closeIn,
      },
      candles: resampled,
      indicators: pack.snapshot,
      ema9Series: pack.ema9Series,
      ema21Series: pack.ema21Series,
      ema50Series: pack.ema50Series,
      bbUpperSeries: pack.bbUpperSeries,
      bbLowerSeries: pack.bbLowerSeries,
    };
  }

  if (brokerId === 'AUTO_SPOT') {
    return getSpotFallbackSnapshot(timeframe, forceRefresh);
  }

  try {
    return await getTradingViewBrokerSnapshot(brokerId, timeframe);
  } catch (err) {
    console.warn(`[BrokerFeed ${brokerId} ${timeframe}] Fallback ke Spot feed:`, err);
    return getSpotFallbackSnapshot(timeframe, forceRefresh);
  }
}

// ---------- Macro (DXY / US10Y / S&P500), Geopolitics News & Global Dual-Sync ----------

interface MacroCacheEntry {
  data: MacroContext;
  fetchedAt: number;
}
let macroCache: MacroCacheEntry | null = null;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchYahooQuoteMetric(
  symbol: string
): Promise<{ price: number | null; changePct: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=2d&interval=15m`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return { price: null, changePct: null };
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { regularMarketPrice?: number; chartPreviousClose?: number };
        }>;
      };
    };
    const meta = json?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === 'number' ? meta.regularMarketPrice : null;
    const prev = typeof meta?.chartPreviousClose === 'number' ? meta.chartPreviousClose : null;
    if (price === null || price <= 0) return { price: null, changePct: null };
    const changePct =
      prev && prev > 0 ? Number((((price - prev) / prev) * 100).toFixed(2)) : null;
    return { price: Number(price.toFixed(3)), changePct };
  } catch {
    return { price: null, changePct: null };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGoldGeopoliticsHeadlines(): Promise<
  Array<{ title: string; source: string; pubDate: string }>
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3200);
  try {
    const rssUrl =
      'https://news.google.com/rss/search?q=XAUUSD+OR+%22gold+price%22+OR+%22Federal+Reserve%22+OR+DXY+geopolitics&hl=en-US&gl=US&ceid=US:en';
    const res = await fetch(rssUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: Array<{ title: string; source: string; pubDate: string }> = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRegex.exec(xml)) !== null && items.length < 5) {
      const block = m[1];
      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
      const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
      const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : '';
      const source = sourceMatch ? decodeXmlEntities(sourceMatch[1]) : 'Google News';
      const pubDate = dateMatch ? decodeXmlEntities(dateMatch[1]).slice(0, 22) : '';
      if (title) {
        items.push({ title, source, pubDate });
      }
    }
    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMacroAndGeopoliticsContext(): Promise<MacroContext> {
  if (macroCache && Date.now() - macroCache.fetchedAt < 120_000) {
    return macroCache.data;
  }
  const [dxy, us10y, sp500, headlines] = await Promise.all([
    fetchYahooQuoteMetric('DX-Y.NYB'),
    fetchYahooQuoteMetric('^TNX'),
    fetchYahooQuoteMetric('^GSPC'),
    fetchGoldGeopoliticsHeadlines(),
  ]);

  const dxyBias: MacroContext['dxyBias'] =
    dxy.changePct !== null
      ? dxy.changePct >= 0.12
        ? 'MENGUAT'
        : dxy.changePct <= -0.12
        ? 'MELEMAH'
        : 'NETRAL'
      : 'NETRAL';

  const data: MacroContext = {
    dxyPrice: dxy.price,
    dxyChangePct: dxy.changePct,
    dxyBias,
    us10yYield: us10y.price,
    us10yChangePct: us10y.changePct,
    sp500Price: sp500.price,
    sp500ChangePct: sp500.changePct,
    headlines,
    updatedAt: Date.now(),
  };
  macroCache = { data, fetchedAt: Date.now() };
  return data;
}

interface GlobalSyncContext {
  consensusMid: number;
  maxDeviationUsd: number;
  syncStatus: 'ALIGNED' | 'SPREAD_DIVERGENCE';
  quotes: Array<{ source: string; mid: number }>;
  summary: string;
}

let globalSyncCache: { data: GlobalSyncContext; fetchedAt: number; refMid: number } | null = null;

async function fetchGlobalXauSyncContext(primaryQuote: MarketQuote): Promise<GlobalSyncContext> {
  if (
    globalSyncCache &&
    Date.now() - globalSyncCache.fetchedAt < 12_000 &&
    Math.abs(globalSyncCache.refMid - primaryQuote.mid) < 1.5
  ) {
    return globalSyncCache.data;
  }

  const [yahooSpot, yahooFutures, binancePaxg] = await Promise.all([
    fetchYahooQuoteMetric('XAUUSD=X'),
    fetchYahooQuoteMetric('GC=F'),
    fetchBinancePaxg('M5').catch(() => null),
  ]);

  const quotes: Array<{ source: string; mid: number }> = [
    { source: primaryQuote.source, mid: primaryQuote.mid },
  ];
  if (yahooSpot.price && yahooSpot.price > 1000) {
    quotes.push({ source: 'Yahoo Spot (XAUUSD=X)', mid: Number(yahooSpot.price.toFixed(2)) });
  }
  if (yahooFutures.price && yahooFutures.price > 1000) {
    quotes.push({ source: 'COMEX Gold Futures (GC=F)', mid: Number(yahooFutures.price.toFixed(2)) });
  }
  if (binancePaxg && binancePaxg.mid > 1000) {
    quotes.push({ source: 'Binance PAXG/USDT', mid: binancePaxg.mid });
  }

  const mids = quotes.map((q) => q.mid).sort((a, b) => a - b);
  const consensusMid =
    mids.length > 0 ? mids[Math.floor(mids.length / 2)] : primaryQuote.mid;
  const maxDeviationUsd = Number(
    Math.max(0, ...quotes.map((q) => Math.abs(q.mid - primaryQuote.mid))).toFixed(2)
  );
  const syncStatus: GlobalSyncContext['syncStatus'] =
    maxDeviationUsd <= 4.5 ? 'ALIGNED' : 'SPREAD_DIVERGENCE';

  const partsText = quotes.map((q) => `${q.source}: ${q.mid.toFixed(2)}`).join(' | ');
  const summary = `Konsensus Global ${consensusMid.toFixed(2)} (${syncStatus}, deviasi maks ±$${maxDeviationUsd.toFixed(
    2
  )}) — ${partsText}`;

  const data: GlobalSyncContext = {
    consensusMid: Number(consensusMid.toFixed(2)),
    maxDeviationUsd,
    syncStatus,
    quotes,
    summary,
  };
  globalSyncCache = { data, fetchedAt: Date.now(), refMid: primaryQuote.mid };
  return data;
}

const mtfSummaryCache = new Map<string, { text: string; fetchedAt: number }>();

function summarizeSnapshotTf(label: string, snap: MarketSnapshot): string {
  const ind = snap.indicators;
  const emaBias =
    ind.ema9 !== null && ind.ema21 !== null
      ? ind.ema9 > ind.ema21
        ? 'BULLISH'
        : 'BEARISH'
      : 'NETRAL';
  const struct = ind.structure?.marketStructure ?? 'N/A';
  const rsi = ind.rsi14 !== null ? ind.rsi14.toFixed(1) : 'N/A';
  const adx = ind.adx14 !== null && ind.adx14 !== undefined ? ind.adx14.toFixed(1) : 'N/A';
  const r1 = ind.structure?.nearestResistance?.price.toFixed(2) ?? 'N/A';
  const s1 = ind.structure?.nearestSupport?.price.toFixed(2) ?? 'N/A';
  return `${label}: Bias=${emaBias} | Struct=${struct} | RSI=${rsi} | ADX=${adx} | S1=${s1} / R1=${r1}`;
}

async function fetchMultiTimeframeSummary(
  brokerId: BrokerFeedId,
  activeTf: ChartTimeframe,
  primarySnapshot: MarketSnapshot
): Promise<{ promptBlock: string; compactSummary: string }> {
  const cacheKey = `${brokerId}:${activeTf}`;
  const cached = mtfSummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 25_000) {
    return {
      promptBlock: cached.text,
      compactSummary: cached.text.split('\n').join(' · '),
    };
  }

  const tfList: ChartTimeframe[] = ['M5', 'M15', 'M30', 'H1'];
  const settled = await Promise.allSettled(
    tfList.map((tf) =>
      tf === activeTf ? Promise.resolve(primarySnapshot) : getMarketSnapshot(brokerId, tf, false)
    )
  );

  const lines: string[] = [];
  let h1Candles: Candle[] | null = null;
  settled.forEach((res, idx) => {
    const tf = tfList[idx];
    if (res.status === 'fulfilled') {
      lines.push(summarizeSnapshotTf(tf, res.value));
      if (tf === 'H1') h1Candles = res.value.candles;
    }
  });

  if (h1Candles && (h1Candles as Candle[]).length >= 24) {
    const h4Candles: Candle[] = [];
    const src = h1Candles as Candle[];
    for (let i = 0; i < src.length; i += 4) {
      const grp = src.slice(i, i + 4);
      if (grp.length === 0) continue;
      h4Candles.push({
        time: grp[0].time,
        open: grp[0].open,
        high: Math.max(...grp.map((c) => c.high)),
        low: Math.min(...grp.map((c) => c.low)),
        close: grp[grp.length - 1].close,
        volume: grp.reduce((a, c) => a + c.volume, 0),
      });
    }
    if (h4Candles.length >= 10) {
      const h4Pack = buildIndicatorPack(h4Candles);
      const lastH4 = h4Candles[h4Candles.length - 1];
      const h4Bias =
        h4Pack.snapshot.ema9 !== null && h4Pack.snapshot.ema21 !== null
          ? h4Pack.snapshot.ema9 > h4Pack.snapshot.ema21
            ? 'BULLISH'
            : 'BEARISH'
          : lastH4.close >= lastH4.open
          ? 'BULLISH'
          : 'BEARISH';
      lines.push(
        `H4 (Aggregasi 4xH1): Bias=${h4Bias} | Struct=${
          h4Pack.snapshot.structure?.marketStructure ?? 'N/A'
        } | RSI=${h4Pack.snapshot.rsi14 ?? 'N/A'}`
      );
    }
  }

  const promptBlock =
    lines.length > 0 ? lines.join('\n') : summarizeSnapshotTf(activeTf, primarySnapshot);
  mtfSummaryCache.set(cacheKey, { text: promptBlock, fetchedAt: Date.now() });
  return {
    promptBlock,
    compactSummary: lines.slice(0, 4).join(' · ') || summarizeSnapshotTf(activeTf, primarySnapshot),
  };
}

// ---------- Express App Setup ----------

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    const keys = getConfiguredGeminiKeys();
    const airforce = getAirforceConfig();
    const openrouter = getOpenRouterDecisionsConfig();
    res.json({
      ok: true,
      hasGeminiKey: keys.length > 0,
      geminiKeySlots: keys.length,
      keySlotNames: keys.map((k) => k.name),
      model: 'gemini-4-hydrogen / gemini-4-argon',
      hasAirforceKey: airforce !== null,
      airforceBaseUrl: airforce?.baseUrl ?? 'https://api.airforce/v1',
      airforceModel: airforce?.model ?? 'deepseek-v3',
      hasOpenRouterKey: openrouter !== null,
      openRouterDecisionsUrl:
        openrouter?.decisionsUrl ?? 'https://openrouter.ai/api/alpha/decisions',
      openRouterModel: openrouter?.model ?? 'perplexity/pplx-decider-flash-v1.3:free',
      openRouterDecisionModels: [
        openrouter?.respanModel ?? 'respan/span-01-lite:free',
        openrouter?.model ?? 'perplexity/pplx-decider-flash-v1.3:free',
        openrouter?.heygenModel ?? 'heygen/heygen-decision-1-turbo',
        openrouter?.drexModel ?? 'nace-ai/drex-max',
        openrouter?.jevModel ?? 'typesafe/jev-1.14',
      ],
      openRouterChatModels: [
        openrouter?.argonModel ?? 'google/gemini-4-argon',
        openrouter?.hydrogenModel ?? 'google/gemini-4-hydrogen',
        openrouter?.nemotronModel ?? 'nvidia/nemotron-3-ultra-550b-a55b:free',
        openrouter?.kimiModel ?? 'moonshotai/kimi-k3.1-pro',
      ],
      defaultThinkingLevel: 'HIGH',
      timestamp: Date.now(),
    });
  });

  // ---------- MetaTrader 5 Real Account & Order Bridge State ----------
  interface Mt5Command {
    id: string;
    action: 'BUY' | 'SELL' | 'CLOSE' | 'CLOSE_ALL' | 'MODIFY_TP';
    lots?: number;
    sl?: number;
    tp?: number;
    ticket?: number;
    side?: 'BUY' | 'SELL';
    refEntry?: number;
    comment?: string;
    createdAt: number;
    deliveredTo: Set<string>;
  }

  let mt5Profile: Mt5AccountConfig | null = null;
  let mt5LastHeartbeatAt: number | null = null;
  let mt5LiveAccount: Mt5BridgeStatus['liveAccount'] = null;
  let mt5CommandQueue: Mt5Command[] = [];
  const mt5ConnectedTerminals = new Map<
    string,
    {
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
  >();

  function buildMt5StatusPayload(): Mt5BridgeStatus {
    const now = Date.now();
    const activeTerminals = Array.from(mt5ConnectedTerminals.values()).filter(
      (t) => now - t.lastSeenAt < 15000
    );
    const isConnected =
      mt5Profile !== null &&
      mt5LastHeartbeatAt !== null &&
      now - mt5LastHeartbeatAt < 15000;

    return {
      configured: mt5Profile !== null,
      connected: isConnected,
      profile: mt5Profile,
      lastHeartbeatAt: mt5LastHeartbeatAt,
      liveAccount: mt5LiveAccount,
      pendingCommandsCount: mt5CommandQueue.length,
      connectedTerminals: activeTerminals,
    };
  }

  app.post('/api/mt5/account/connect', (req, res) => {
    const body = req.body as {
      login?: string;
      password?: string;
      server?: string;
      accountType?: 'REAL' | 'DEMO';
    };

    const login = String(body.login || '').trim();
    const password = String(body.password || '');
    const server = String(body.server || '').trim();
    const accountType = body.accountType === 'DEMO' ? 'DEMO' : 'REAL';

    if (!login || !/^\d{3,15}$/.test(login)) {
      res.status(400).json({ error: 'Nomor Login MT5 harus berupa angka 3-15 digit.' });
      return;
    }
    if (!server || server.length < 3) {
      res.status(400).json({ error: 'Nama Server Broker MT5 wajib diisi (contoh: Exness-MT5Real12).' });
      return;
    }
    if (!password || password.length < 3) {
      res.status(400).json({ error: 'Password trading akun MT5 wajib diisi.' });
      return;
    }

    // Derive deterministic bridgeKey without ever storing or echoing the plaintext password
    const secretSalt = process.env.GEMINI_API_KEY || 'aurumea-mt5-bridge';
    const digest = crypto
      .createHmac('sha256', secretSalt)
      .update(`${login}|${server}|${password}`)
      .digest('hex')
      .slice(0, 24);

    mt5Profile = {
      login,
      server,
      accountType,
      bridgeKey: `aurum_${digest}`,
      configuredAt: Date.now(),
    };
    mt5LastHeartbeatAt = null;
    mt5LiveAccount = null;
    mt5CommandQueue = [];
    mt5ConnectedTerminals.clear();

    res.json(buildMt5StatusPayload());
  });

  app.post('/api/mt5/account/disconnect', (_req, res) => {
    mt5Profile = null;
    mt5LastHeartbeatAt = null;
    mt5LiveAccount = null;
    mt5CommandQueue = [];
    mt5ConnectedTerminals.clear();
    res.json(buildMt5StatusPayload());
  });

  app.get('/api/mt5/status', (_req, res) => {
    res.json(buildMt5StatusPayload());
  });

  app.post('/api/mt5/order', (req, res) => {
    const status = buildMt5StatusPayload();
    if (!mt5Profile) {
      res.status(409).json({
        error:
          'Akun MT5 belum dikonfigurasi di Bridge. Daftarkan akun MT5 terlebih dahulu di tab MT5 Bridge.',
      });
      return;
    }

    const body = req.body as {
      action?: 'BUY' | 'SELL' | 'CLOSE' | 'CLOSE_ALL' | 'MODIFY_TP';
      lots?: number;
      sl?: number;
      tp?: number;
      ticket?: number;
      side?: 'BUY' | 'SELL';
      refEntry?: number;
      comment?: string;
    };

    const action = body.action;
    if (
      action !== 'BUY' &&
      action !== 'SELL' &&
      action !== 'CLOSE' &&
      action !== 'CLOSE_ALL' &&
      action !== 'MODIFY_TP'
    ) {
      res.status(400).json({ error: 'Tipe perintah order MT5 tidak valid.' });
      return;
    }

    const cmd: Mt5Command = {
      id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action,
      lots: body.lots,
      sl: body.sl,
      tp: body.tp,
      ticket: body.ticket,
      side: body.side,
      refEntry: body.refEntry,
      comment: (body.comment || 'AurumEA Web').replace(/\|/g, '/').slice(0, 40),
      createdAt: Date.now(),
      deliveredTo: new Set<string>(),
    };
    mt5CommandQueue.push(cmd);
    if (mt5CommandQueue.length > 100) {
      mt5CommandQueue = mt5CommandQueue.slice(-100);
    }

    res.json({
      queued: true,
      connected: status.connected,
      command: { ...cmd, deliveredTo: undefined },
      pendingCommandsCount: mt5CommandQueue.length,
    });
  });

  // Heartbeat & live account/position/feed sync from MT5 EA / DLL
  app.post('/api/mt5/sync', (req, res) => {
    const body = req.body as {
      bridgeKey?: string;
      login?: string;
      server?: string;
      company?: string;
      currency?: string;
      balance?: number;
      equity?: number;
      margin?: number;
      freeMargin?: number;
      leverage?: number;
      tradeAllowed?: boolean;
      positions?: Mt5LivePosition[];
      symbol?: string;
      bid?: number;
      ask?: number;
      candles?: Candle[];
    };

    if (!mt5Profile) {
      res.status(404).json({
        error: 'Belum ada akun MT5 yang didaftarkan di web terminal.',
        mt5Line: 'NONE',
      });
      return;
    }

    const keyMatch = body.bridgeKey && body.bridgeKey === mt5Profile.bridgeKey;
    const loginServerMatch =
      String(body.login || '').trim() === mt5Profile.login &&
      String(body.server || '').trim().toLowerCase() === mt5Profile.server.toLowerCase();

    if (!keyMatch && !loginServerMatch) {
      res.status(401).json({
        error: `Kredensial Bridge tidak cocok dengan akun terdaftar (${mt5Profile.login} @ ${mt5Profile.server}).`,
        mt5Line: 'NONE',
      });
      return;
    }

    const loginStr = String(body.login || mt5Profile.login).trim();
    const serverStr = String(body.server || mt5Profile.server).trim();
    const terminalId = `${loginStr}@${serverStr.toLowerCase()}`;
    const isPrimaryTerminal =
      loginStr === mt5Profile.login &&
      serverStr.toLowerCase() === mt5Profile.server.toLowerCase();

    mt5LastHeartbeatAt = Date.now();
    const incomingPositions = Array.isArray(body.positions) ? body.positions : [];

    mt5ConnectedTerminals.set(terminalId, {
      terminalId,
      login: loginStr,
      server: serverStr,
      company: String(body.company || 'MetaTrader 5 Broker'),
      currency: String(body.currency || 'USD'),
      balance: Number(body.balance ?? 0),
      equity: Number(body.equity ?? 0),
      positionsCount: incomingPositions.length,
      isPrimary: isPrimaryTerminal,
      lastSeenAt: mt5LastHeartbeatAt,
    });

    if (isPrimaryTerminal || !mt5LiveAccount) {
      mt5LiveAccount = {
        login: loginStr,
        server: serverStr,
        company: String(body.company || 'MetaTrader 5 Broker'),
        currency: String(body.currency || 'USD'),
        balance: Number(body.balance ?? 0),
        equity: Number(body.equity ?? 0),
        margin: Number(body.margin ?? 0),
        freeMargin: Number(body.freeMargin ?? 0),
        leverage: Number(body.leverage ?? 100),
        tradeAllowed: Boolean(body.tradeAllowed ?? true),
        positions: incomingPositions,
      };
    }

    // Optional live broker price + M5 candle sync from MT5 EA (primary terminal priority)
    if (isPrimaryTerminal && Array.isArray(body.candles) && body.candles.length >= 30) {
      const cleaned = body.candles
        .filter(
          (c) =>
            typeof c.time === 'number' &&
            typeof c.open === 'number' &&
            typeof c.high === 'number' &&
            typeof c.low === 'number' &&
            typeof c.close === 'number'
        )
        .map((c) => ({ ...c, time: alignToM5(c.time) }))
        .sort((a, b) => a.time - b.time);

      if (cleaned.length >= 30) {
        const last = cleaned[cleaned.length - 1];
        const bid = Number((body.bid && body.bid > 0 ? body.bid : last.close).toFixed(2));
        const ask = Number((body.ask && body.ask > 0 ? body.ask : bid + 0.2).toFixed(2));
        const mid = Number(((bid + ask) / 2).toFixed(2));
        const pack = buildIndicatorPack(cleaned);
        const nowSec = Math.floor(Date.now() / 1000);
        const boundary = alignToM5(nowSec);
        const firstOpen = cleaned[0].open;
        const change24h = Number((mid - firstOpen).toFixed(2));

        mt5LiveSnapshot = {
          quote: {
            symbol: body.symbol || 'XAU/USD',
            timeframe: 'M5',
            bid,
            ask,
            mid,
            spread: Number(Math.max(0, ask - bid).toFixed(2)),
            change24h,
            changePercent24h:
              firstOpen > 0 ? Number(((change24h / firstOpen) * 100).toFixed(2)) : 0,
            high24h: Number(Math.max(...cleaned.map((c) => c.high)).toFixed(2)),
            low24h: Number(Math.min(...cleaned.map((c) => c.low)).toFixed(2)),
            source: `MT5 ${mt5LiveAccount.company} (${mt5LiveAccount.server})`,
            brokerId: 'MT5_LIVE',
            brokerSymbol: `${mt5LiveAccount.server}:${body.symbol || 'XAUUSD'}`,
            marketStatus: 'LIVE',
            updatedAt: Date.now(),
            candleCloseInSec: Math.max(0, boundary + 300 - nowSec),
          },
          candles: cleaned,
          indicators: pack.snapshot,
          ema9Series: pack.ema9Series,
          ema21Series: pack.ema21Series,
          ema50Series: pack.ema50Series,
          bbUpperSeries: pack.bbUpperSeries,
          bbLowerSeries: pack.bbLowerSeries,
        };
        mt5LiveFeedUpdatedAt = Date.now();
      }
    } else if (
      isPrimaryTerminal &&
      mt5LiveSnapshot &&
      body.bid &&
      body.ask &&
      body.bid > 0 &&
      body.ask > 0
    ) {
      const bid = Number(body.bid.toFixed(2));
      const ask = Number(body.ask.toFixed(2));
      const mid = Number(((bid + ask) / 2).toFixed(2));
      mt5LiveSnapshot.quote.bid = bid;
      mt5LiveSnapshot.quote.ask = ask;
      mt5LiveSnapshot.quote.mid = mid;
      mt5LiveSnapshot.quote.spread = Number(Math.max(0, ask - bid).toFixed(2));
      mt5LiveSnapshot.quote.updatedAt = Date.now();
      mt5LiveFeedUpdatedAt = Date.now();
    }

    const nowTs = Date.now();
    const activeIds = Array.from(mt5ConnectedTerminals.entries())
      .filter(([, info]) => nowTs - info.lastSeenAt < 30000)
      .map(([id]) => id);

    // Prune expired commands (> 90s) or commands already delivered to every active terminal
    mt5CommandQueue = mt5CommandQueue.filter((cmd) => {
      if (nowTs - cmd.createdAt > 90_000) return false;
      if (activeIds.length > 0 && activeIds.every((id) => cmd.deliveredTo.has(id))) return false;
      return true;
    });

    const nextCmd = mt5CommandQueue.find((cmd) => !cmd.deliveredTo.has(terminalId));
    let mt5Line = 'NONE';
    if (nextCmd) {
      nextCmd.deliveredTo.add(terminalId);
      if (nextCmd.action === 'BUY' || nextCmd.action === 'SELL') {
        mt5Line = [
          'CMD',
          nextCmd.id,
          nextCmd.action,
          Number(nextCmd.lots || 0.01).toFixed(2),
          Number(nextCmd.sl || 0).toFixed(2),
          Number(nextCmd.tp || 0).toFixed(2),
          nextCmd.comment || 'AurumEA',
          Number(nextCmd.refEntry || 0).toFixed(2),
        ].join('|');
      } else if (nextCmd.action === 'CLOSE') {
        mt5Line = [
          'CMD',
          nextCmd.id,
          'CLOSE',
          String(nextCmd.ticket || 0),
          nextCmd.side || '',
          nextCmd.comment || '',
        ].join('|');
      } else if (nextCmd.action === 'CLOSE_ALL') {
        mt5Line = ['CMD', nextCmd.id, 'CLOSE_ALL'].join('|');
      } else if (nextCmd.action === 'MODIFY_TP') {
        mt5Line = [
          'CMD',
          nextCmd.id,
          'MODIFY_TP',
          nextCmd.side || 'BUY',
          Number(nextCmd.tp || 0).toFixed(2),
          String(nextCmd.ticket || 0),
          Number(nextCmd.refEntry || 0).toFixed(2),
        ].join('|');
      }

      if (activeIds.length > 0 && activeIds.every((id) => nextCmd.deliveredTo.has(id))) {
        mt5CommandQueue = mt5CommandQueue.filter((c) => c.id !== nextCmd.id);
      }
    }

    res.json({ ok: true, mt5Line });
  });

  app.get('/api/market/macro', async (_req, res) => {
    try {
      const macro = await fetchMacroAndGeopoliticsContext();
      res.json(macro);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memuat data makro DXY.';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/market/candles', async (req, res) => {
    try {
      const brokerId = normalizeBrokerId(req.query.broker);
      const timeframe = normalizeTimeframe(req.query.timeframe);
      const snapshot = await getMarketSnapshot(brokerId, timeframe, false);
      res.json(snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal memuat data chart XAU/USD.';
      res.status(502).json({ error: message });
    }
  });

  // Real-time Server-Sent Events stream for XAU/USD ticks per selected broker & timeframe
  app.get('/api/market/stream', async (req, res) => {
    const brokerId = normalizeBrokerId(req.query.broker);
    const timeframe = normalizeTimeframe(req.query.timeframe);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;

    const pushTick = async (force: boolean) => {
      if (closed) return;
      try {
        const snapshot = await getMarketSnapshot(brokerId, timeframe, force);
        if (!closed) {
          res.write(`event: tick\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
      } catch (err) {
        if (!closed) {
          const message = err instanceof Error ? err.message : 'Feed error';
          res.write(`event: feed_error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        }
      }
    };

    await pushTick(false);

    const interval = setInterval(() => {
      void pushTick(true);
    }, 1500);

    req.on('close', () => {
      closed = true;
      clearInterval(interval);
    });
  });

  // Real-time multi-provider AI Expert Advisor analysis endpoint (Gemini 4 Pro + Airforce deepseek-v3)
  app.post('/api/ea/analyze', async (req, res) => {
    const startTime = Date.now();
    let requestedProvider: AiProviderMode = 'AUTO';
    const useStreamKeepAlive = req.headers['x-aurum-stream'] === '1';
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    if (useStreamKeepAlive) {
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.write(' ');
      keepAliveTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(' ');
        }
      }, 5000);
      res.on('close', () => {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
      });
    }
    try {
      const body = req.body as {
        chartImageBase64?: string;
        uploadedChartImageBase64?: string;
        strategyFocus?:
          | 'ADAPTIVE_SCALP'
          | 'BALANCED'
          | 'SCALPING_EMA'
          | 'ULTRA_SCALP'
          | 'LIQUIDITY_SMC';
        brokerFeed?: BrokerFeedId;
        timeframe?: ChartTimeframe;
        riskPercent?: number;
        accountBalance?: number;
        openPositionsCount?: number;
        openPositionsSummary?: string;
        openPositionsDetail?: Array<{
          id?: string;
          side: 'BUY' | 'SELL';
          lots: number;
          entryPrice: number;
          takeProfit: number;
          floatingPnlUsd: number;
          openedMinutesAgo: number;
        }>;
        noSlAiExit?: boolean;
        mt5Symbol?: string;
        mt5Bid?: number;
        mt5Ask?: number;
        mt5SpreadPoints?: number;
        fullAiControl?: boolean;
        aiProvider?: AiProviderMode;
        aiThinkingHigh?: boolean;
        mt5Candles?: Candle[];
        mt5M1Candles?: Candle[];
        recentClosedTrades?: RecentClosedTradeContext[];
      };

      const validProviders: AiProviderMode[] = [
        'AUTO',
        'ROUND_ROBIN',
        'OPENROUTER_RESPAN_PPLX',
        'GEMINI',
        'AIRFORCE',
        'OPENROUTER',
        'OPENROUTER_RESPAN',
        'OPENROUTER_HEYGEN',
        'OPENROUTER_DREX',
        'OPENROUTER_JEV',
        'OPENROUTER_PPLX',
        'OPENROUTER_ARGON',
        'OPENROUTER_HYDROGEN',
        'OPENROUTER_NEMOTRON',
        'OPENROUTER_KIMI',
      ];
      const requestedRaw = String(body.aiProvider || 'AUTO').toUpperCase().trim() as AiProviderMode;
      requestedProvider = validProviders.includes(requestedRaw) ? requestedRaw : 'AUTO';
      const thinkingHigh = body.aiThinkingHigh ?? true;

      const requestedTf = normalizeTimeframe(body.timeframe);
      const tfSec = TIMEFRAME_META[requestedTf].seconds;

      let snapshot: MarketSnapshot;
      if (Array.isArray(body.mt5Candles) && body.mt5Candles.length >= 30) {
        const cleanedCandles = body.mt5Candles
          .filter(
            (c) =>
              typeof c.time === 'number' &&
              typeof c.open === 'number' &&
              typeof c.high === 'number' &&
              typeof c.low === 'number' &&
              typeof c.close === 'number'
          )
          .sort((a, b) => a.time - b.time);

        const last = cleanedCandles[cleanedCandles.length - 1];
        const bid = Number((body.mt5Bid && body.mt5Bid > 0 ? body.mt5Bid : last.close).toFixed(2));
        const ask = Number(
          (body.mt5Ask && body.mt5Ask > 0 ? body.mt5Ask : bid + 0.25).toFixed(2)
        );
        const mid = Number(((bid + ask) / 2).toFixed(2));
        const pack = buildIndicatorPack(cleanedCandles);
        const nowSec = Math.floor(Date.now() / 1000);
        const boundary = Math.floor(nowSec / tfSec) * tfSec;
        const firstOpen = cleanedCandles[0].open;
        const change24h = Number((mid - firstOpen).toFixed(2));

        snapshot = {
          quote: {
            symbol: body.mt5Symbol || 'XAU/USD',
            timeframe: requestedTf,
            bid,
            ask,
            mid,
            spread: Number((ask - bid).toFixed(2)),
            change24h,
            changePercent24h:
              firstOpen > 0 ? Number(((change24h / firstOpen) * 100).toFixed(2)) : 0,
            high24h: Number(Math.max(...cleanedCandles.map((c) => c.high)).toFixed(2)),
            low24h: Number(Math.min(...cleanedCandles.map((c) => c.low)).toFixed(2)),
            source: `MetaTrader 5 (${body.mt5Symbol || 'XAUUSD'})`,
            brokerId: 'MT5_LIVE',
            marketStatus: 'LIVE',
            updatedAt: Date.now(),
            candleCloseInSec: Math.max(0, boundary + tfSec - nowSec),
          },
          candles: cleanedCandles,
          indicators: pack.snapshot,
          ema9Series: pack.ema9Series,
          ema21Series: pack.ema21Series,
          ema50Series: pack.ema50Series,
          bbUpperSeries: pack.bbUpperSeries,
          bbLowerSeries: pack.bbLowerSeries,
        };
      } else {
        const brokerId = normalizeBrokerId(body.brokerFeed);
        snapshot = await getMarketSnapshot(brokerId, requestedTf, true);
      }
      const tfLabel = snapshot.quote.timeframe || requestedTf;

      const recentCandles = snapshot.candles.slice(-30);
      const lastCandle = recentCandles[recentCandles.length - 1];
      const ind = snapshot.indicators;

      const candleTable = recentCandles
        .map((c) => {
          const iso = new Date(c.time * 1000).toISOString().slice(11, 16);
          const dir = c.close >= c.open ? 'BULL' : 'BEAR';
          const bodySz = Math.abs(c.close - c.open).toFixed(2);
          const upWick = (c.high - Math.max(c.open, c.close)).toFixed(2);
          const dnWick = (Math.min(c.open, c.close) - c.low).toFixed(2);
          return `${iso} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} | Body:${bodySz} UW:${upWick} LW:${dnWick} (${dir})`;
        })
        .join('\n');

      // Optional M1 micro-structure table sent by MT5 Scalping EA v2.00
      let m1Section = '';
      if (Array.isArray(body.mt5M1Candles) && body.mt5M1Candles.length >= 5) {
        const m1Clean = body.mt5M1Candles
          .filter(
            (c) =>
              typeof c.time === 'number' &&
              typeof c.open === 'number' &&
              typeof c.high === 'number' &&
              typeof c.low === 'number' &&
              typeof c.close === 'number'
          )
          .sort((a, b) => a.time - b.time)
          .slice(-15);

        const m1Lines = m1Clean
          .map((c) => {
            const iso = new Date(c.time * 1000).toISOString().slice(11, 16);
            const dir = c.close >= c.open ? 'BULL' : 'BEAR';
            return `${iso} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} (${dir})`;
          })
          .join('\n');
        m1Section = `\n15 CANDLE M1 TERAKHIR (MICRO TIMING SCALPING):\n${m1Lines}\n`;
      }

      // Compute EMA 9/21 slope & gap for scalping momentum context
      const ema9Last = snapshot.ema9Series[snapshot.ema9Series.length - 1]?.value ?? null;
      const ema9Prev = snapshot.ema9Series[snapshot.ema9Series.length - 4]?.value ?? null;
      const ema9Slope =
        ema9Last !== null && ema9Prev !== null ? Number((ema9Last - ema9Prev).toFixed(2)) : null;
      const emaGap =
        ind.ema9 !== null && ind.ema21 !== null ? Number((ind.ema9 - ind.ema21).toFixed(2)) : null;

      const strategyInstructionMap: Record<string, string> = {
        ADAPTIVE_SCALP:
          'MODE GABUNGAN AUTO ADAPTIVE (TARGET WINRATE >80% & PROFITABLE): EA/AI wajib memilih sendiri secara dinamis apakah kondisi pasar saat ini paling cocok memakai (A) Scalping Momentum M5 (EMA 9/21/50 searah + Tight ATR saat tren bersih & ADX mendukung) ATAU (B) Ultra-Scalping M1+M5 Sniper Breakout (saat breakout kompresi / sweep likuiditas + konfirmasi micro candle & penolakan S/R). WAJIB selektif ala sniper: hanya eksekusi BUY/SELL bila peluang win estimasi >80% (di atas 80%) dan jalur ke TP1 bebas dari tembok S/R penghalang; jika struktur choppy/meragukan/≤80%, wajib pilih HOLD demi menjaga winrate tinggi dan profitabilitas. Sebutkan mode yang dipilih ([Momentum M5] atau [Sniper M1+M5]) pada setupPattern & judgeVerdict.',
        BALANCED:
          'Preferensi Horizon: Intraday/Swing seimbang. AI bebas menentukan sendiri arah BUY, SELL, atau HOLD berdasarkan pembacaan pasar mandiri; indikator hanya penunjang opsional.',
        SCALPING_EMA:
          'Preferensi Horizon: Scalping cepat M5 (target hit relatif cepat). AI bebas sepenuhnya menentukan BUY, SELL, atau HOLD secara mandiri dari pembacaan harga/momentum—JANGAN terpaku menunggu EMA bersilangan atau selaras.',
        ULTRA_SCALP:
          'Preferensi Horizon: Ultra-Scalp micro M1+M5. AI menilai sendiri pergerakan micro candle & likuiditas secara independen untuk memutuskan BUY, SELL, atau HOLD tanpa terikat aturan indikator.',
        LIQUIDITY_SMC:
          'Preferensi Horizon: Price Action / Likuiditas. AI bebas membaca reaksi harga di area likuiditas secara mandiri dan mengambil keputusan BUY, SELL, atau HOLD meskipun indikator menunjukkan arah berlawanan.',
      };

      const strategyFocus = body.strategyFocus || 'ADAPTIVE_SCALP';
      const isScalpMode =
        strategyFocus === 'ADAPTIVE_SCALP' ||
        strategyFocus === 'SCALPING_EMA' ||
        strategyFocus === 'ULTRA_SCALP';
      const fullAiControl = body.fullAiControl ?? true;
      const noSlAiExit = body.noSlAiExit ?? true;
      const openPositionsCount = Math.max(
        body.openPositionsCount ?? 0,
        Array.isArray(body.openPositionsDetail) ? body.openPositionsDetail.length : 0
      );
      const atrValue = ind.atr14 ?? 2.5;
      const spreadInfo =
        typeof body.mt5SpreadPoints === 'number'
          ? `${snapshot.quote.spread} USD (${body.mt5SpreadPoints} pts MT5)`
          : `${snapshot.quote.spread} USD`;
      const slGuide = isScalpMode
        ? `${(atrValue * 0.95).toFixed(2)} - ${(atrValue * 1.15).toFixed(2)}`
        : `${(atrValue * 1.3).toFixed(2)} - ${(atrValue * 1.7).toFixed(2)}`;
      const tpGuide = isScalpMode
        ? `${(atrValue * 1.25).toFixed(2)} - ${(atrValue * 1.6).toFixed(2)}`
        : `${(atrValue * 1.8).toFixed(2)} - ${(atrValue * 2.5).toFixed(2)}`;

      const openDetailLines =
        Array.isArray(body.openPositionsDetail) && body.openPositionsDetail.length > 0
          ? body.openPositionsDetail
              .map(
                (p, idx) =>
                  `  #${idx + 1}: ${p.side} ${p.lots} lot @ ${p.entryPrice.toFixed(2)} | TP: ${p.takeProfit.toFixed(2)} | SL: TANPA SL (0) | Floating: ${p.floatingPnlUsd >= 0 ? '+' : '-'}$${Math.abs(p.floatingPnlUsd).toFixed(2)} | Umur: ${p.openedMinutesAgo} menit`
              )
              .join('\n')
          : '';

      const detailListForPrompt = Array.isArray(body.openPositionsDetail)
        ? body.openPositionsDetail
        : [];
      const calcAvgEntryForSide = (side: 'BUY' | 'SELL'): string | null => {
        const subset = detailListForPrompt.filter((p) => p.side === side);
        if (subset.length === 0) return null;
        const totLot = subset.reduce((s, p) => s + Math.max(0.01, Number(p.lots) || 0.01), 0);
        const totVal = subset.reduce(
          (s, p) => s + Number(p.entryPrice) * Math.max(0.01, Number(p.lots) || 0.01),
          0
        );
        return totLot > 0 ? (totVal / totLot).toFixed(2) : null;
      };
      const avgBuyStr = calcAvgEntryForSide('BUY');
      const avgSellStr = calcAvgEntryForSide('SELL');
      const avgEntryHint = [
        avgBuyStr ? `Rata-rata BUY: ${avgBuyStr}` : null,
        avgSellStr ? `Rata-rata SELL: ${avgSellStr}` : null,
      ]
        .filter(Boolean)
        .join(' | ');

      const positionMonitorInstruction =
        openPositionsCount > 0
          ? `\nSTATUS POSISI TERBUKA SAAT INI (${openPositionsCount} POSISI AKTIF — MODE ${noSlAiExit ? '100% TANPA SL / AI EXIT JUDGE' : 'STANDARD'}):
${openDetailLines || `  Ringkasan: ${body.openPositionsSummary || 'Ada posisi aktif'}`}
${avgEntryHint ? `  ${avgEntryHint}` : ''}
ATURAN KETAT PENILAIAN POSISI TERBUKA (AI EXIT JUDGE — positionDecision), MARTIL SEARAH & ANTI-KONTRADIKSI:
- Posisi TIDAK memiliki hard Stop Loss dan tetap memakai Take Profit (TP) aktif.
- Anda sedang memantau posisi pada timeframe ${tfLabel}.
- WAJIB isi \`winProbability\` (angka 0-100: estimasi peluang posisi terbuka mencapai TP) dan \`reversalConfidence\` (angka 0-100: tingkat keyakinan indikasi harga berubah arah melawan posisi terbuka).
- ATURAN MUTLAK CLOSE ALL:
  * AI HANYA BOLEH memilih \`CLOSE_ALL\` (atau \`CLOSE_BUY\`/\`CLOSE_SELL\`) JIKA KEDUA SYARAT TERPENUHI SEKALIGUS:
    1) Kemungkinan win di bawah 20% (\`winProbability < 20\`), **DAN**
    2) Ada indikasi jelas harga akan berubah arah melawan posisi dengan keyakinan minimal 80% (\`reversalConfidence >= 80\`).
  * Jika \`winProbability >= 20\` ATAU \`reversalConfidence < 80\`, WAJIB isi \`positionDecision\` = \`"KEEP"\` agar TP bekerja dan tidak cut-loss prematur saat pullback minor.
  * Pilih \`"CLOSE_ALL"\` ketika kedua syarat ketat tersebut (\`winProbability < 20\` & \`reversalConfidence >= 80\`) terpenuhi.
- ATURAN BUKA POSISI SAMA / MARTIL SEARAH & ANTI-KONTRADIKSI:
  * Selama masih ada posisi \`SELL\` terbuka yang diputuskan \`KEEP\`, Anda DILARANG KERAS mengeluarkan \`signal = "BUY"\` (wajib \`HOLD\` atau \`SELL\` jika memenuhi syarat Martil).
  * Selama masih ada posisi \`BUY\` terbuka yang diputuskan \`KEEP\`, Anda DILARANG KERAS mengeluarkan \`signal = "SELL"\` (wajib \`HOLD\` atau \`BUY\` jika memenuhi syarat Martil).
  * Anda BOLEH mengeluarkan sinyal **searah** (\`BUY\` jika ada \`BUY\` aktif, atau \`SELL\` jika ada \`SELL\` aktif) sebagai **Layer / Martil** JIKA keyakinan arah masih **minimal 80%** (\`confidence >= 80\`). Jika keyakinan < 80%, set \`signal = "HOLD"\`.
  * Jika Anda menyarankan posisi searah/Martil (atau mengevaluasi basket terbuka), WAJIB hitung \`highProbTp\` dan \`highProbTpConfidence\` (85-99%): tentukan satu harga Take Profit gabungan untuk posisi ke-1 dan posisi ke-2 sekaligus agar probabilitas tersentuh minimal 85% (berada di zona profit di atas rata-rata entry BUY / di bawah rata-rata entry SELL, sebelum tembok S/R terdekat, dalam jangkauan gerak realistis).
- Jelaskan angka peluang win (%) dan alasan indikasi perubahan arah secara spesifik di \`positionReason\`.`
          : `\nSTATUS POSISI TERBUKA: Tidak ada posisi aktif. Set \`positionDecision\` = "NONE", \`winProbability\` = 0, \`reversalConfidence\` = 0, \`highProbTp\` = 0, \`highProbTpConfidence\` = 0, dan \`positionReason\` = "Tidak ada posisi terbuka saat ini."`;

      const recentClosedList: RecentClosedTradeContext[] = Array.isArray(body.recentClosedTrades)
        ? body.recentClosedTrades
            .filter(
              (t) =>
                t &&
                (t.side === 'BUY' || t.side === 'SELL') &&
                Number.isFinite(Number(t.closePrice))
            )
            .slice(0, 5)
        : [];
      const latestClosed = recentClosedList[0] ?? null;
      const hasRecentTpHit = Boolean(
        latestClosed &&
          latestClosed.closeReason === 'TP Hit' &&
          latestClosed.closedMinutesAgo <= 90
      );

      let postTpContextPayload: Record<string, unknown> | null = null;
      let postTpInstruction = `\nKONTEKS PASCA-TP: Tidak ada trade yang baru hit Take Profit dalam 90 menit terakhir. Set \`postTpEvaluation\` = "NONE" dan \`postTpReason\` = "Tidak ada konteks pasca-TP aktif."`;

      if (latestClosed && latestClosed.closedMinutesAgo <= 90) {
        const currentMark =
          latestClosed.side === 'BUY' ? snapshot.quote.bid : snapshot.quote.ask;
        const directionalFollowThrough = Number(
          (latestClosed.side === 'BUY'
            ? currentMark - latestClosed.closePrice
            : latestClosed.closePrice - currentMark
          ).toFixed(2)
        );
        const atrFollowRatio = Number((directionalFollowThrough / Math.max(0.2, atrValue)).toFixed(2));
        const rsiState =
          ind.rsi14 !== null
            ? ind.rsi14 >= 70
              ? `OVERBOUGHT (RSI ${ind.rsi14})`
              : ind.rsi14 <= 30
              ? `OVERSOLD (RSI ${ind.rsi14})`
              : `NETRAL (RSI ${ind.rsi14})`
            : 'N/A';

        const movementLabel =
          directionalFollowThrough >= 0
            ? `MASIH LANJUT SEARAH (+${directionalFollowThrough} USD / +${atrFollowRatio} ATR melampaui titik close ${latestClosed.closePrice.toFixed(2)})`
            : `BERBALIK / TERKOREKSI (${directionalFollowThrough} USD / ${atrFollowRatio} ATR dari titik close ${latestClosed.closePrice.toFixed(2)})`;

        postTpContextPayload = {
          last_trade_side: latestClosed.side,
          last_close_reason: latestClosed.closeReason,
          closed_minutes_ago: latestClosed.closedMinutesAgo,
          entry_price: latestClosed.entryPrice,
          close_price: latestClosed.closePrice,
          take_profit_level: latestClosed.takeProfit,
          current_price: currentMark,
          directional_follow_through_usd: directionalFollowThrough,
          directional_follow_through_atr: atrFollowRatio,
          rsi_zone: rsiState,
          recent_trades: recentClosedList,
        };

        postTpInstruction = `\nKONTEKS PASCA-TP & EVALUASI LANJUTAN TREN (${hasRecentTpHit ? 'TP BARU TERCAPAI!' : 'RIWAYAT TUTUP TERBARU'}):
- Trade Terakhir: ${latestClosed.side} @ ${latestClosed.entryPrice.toFixed(2)} -> ${latestClosed.closeReason} @ ${latestClosed.closePrice.toFixed(2)} (${latestClosed.points >= 0 ? '+' : ''}${latestClosed.points.toFixed(2)} pts / ${latestClosed.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(latestClosed.pnlUsd).toFixed(2)}) sekitar ${latestClosed.closedMinutesAgo} menit lalu.
- Posisi Harga Sekarang vs Titik Tutup: ${currentMark.toFixed(2)} -> ${movementLabel}.
- Kondisi Indikator Penunjang Saat Ini: ${rsiState} | Bollinger Upper=${ind.bollinger.upper ?? 'N/A'} / Lower=${ind.bollinger.lower ?? 'N/A'}.
ATURAN BERPIKIR SITUASIONAL PASCA-TP (WAJIB DIPATUHI):
1. JIKA TP SUDAH TERCAPAI & HARGA MASIH BERLANJUT SEARAH:
   - Jangan langsung menolak entry baru HANYA karena RSI sudah Overbought/Oversold (dalam tren kuat, RSI bisa bertahan overbought/oversold sementara harga terus ekspansi), NAMUN jangan juga asal FOMO masuk karena takut ketinggalan ("takut ketinggalan kereta").
   - Evaluasi situasinya secara utuh dari struktur candle terakhir, ukuran body vs ekor penolakan, order flow, dan ruang likuiditas berikutnya:
     * Pilih \`postTpEvaluation\` = "RE_ENTRY_CONTINUATION" dan boleh buka order searah baru (${latestClosed.side}) HANYA JIKA momentum kelanjutan masih solid, candle masih dorong bersih tanpa penolakan ekor ekstrem, dan masih ada ruang ke swing/likuiditas berikutnya.
     * Pilih \`postTpEvaluation\` = "WAIT_PULLBACK_HOLD" dan keluarkan sinyal "HOLD" jika tren masih sehat tapi harga sudah terlalu melar sesaat atau baru saja terjadi profit-taking kecil sehingga lebih bijak menunggu pullback bersih.
     * Pilih \`postTpEvaluation\` = "EXHAUSTION_SKIP" dan keluarkan sinyal "HOLD" jika kelanjutan harga mulai melemah (body mengecil, wick penolakan panjang, divergence, atau trap pasca-sweep).
2. ATURAN KERAS ANTI-BALIK ARAH SPONTAN ("JANGAN KARENA HARGA BERBALIK MAKA OPEN POSISI LAGI"):
   - DILARANG KERAS langsung membuka posisi berlawanan arah (misal langsung \`SELL\` setelah \`BUY\` kena TP hanya karena harga berbalik turun sedikit, atau langsung \`BUY\` setelah \`SELL\` kena TP hanya karena harga memantul sedikit).
   - Koreksi/pantulan setelah TP hit sangat sering hanya berupa aksi ambil untung (profit-taking) sesaat sebelum tren berlanjut atau konsolidasi.
   - Jika harga berbalik/terkoreksi setelah TP tercapai dan belum ada pembalikan struktur multi-candle yang benar-benar terkonfirmasi penuh (BOS/CHoCH kuat + dominasi order flow berlawanan), keputusan yang benar adalah "HOLD" (\`WAIT_PULLBACK_HOLD\` atau \`EXHAUSTION_SKIP\`), BUKAN membuka posisi balik arah.`;
      }

      const deepLearningTelemetry = buildDeepLearningTelemetry(snapshot.candles, atrValue);
      const chartStructure =
        ind.structure ?? analyzeChartStructure(snapshot.candles, atrValue);

      const brokerIdForMtf = normalizeBrokerId(body.brokerFeed);
      const [macroContext, globalSync, mtfData] = await Promise.all([
        fetchMacroAndGeopoliticsContext(),
        fetchGlobalXauSyncContext(snapshot.quote),
        fetchMultiTimeframeSummary(brokerIdForMtf, requestedTf, snapshot),
      ]);

      const resistanceLines =
        chartStructure.resistances.length > 0
          ? chartStructure.resistances
              .map(
                (r) =>
                  `  * ${r.label}: ${r.price.toFixed(2)} (jarak +${r.distanceUsd.toFixed(
                    2
                  )} USD / ${r.distanceAtr} ATR di atas harga sekarang)`
              )
              .join('\n')
          : '  * Belum ada cluster Resistance terdekat di atas harga saat ini (area blue-sky / breakout baru).';

      const supportLines =
        chartStructure.supports.length > 0
          ? chartStructure.supports
              .map(
                (s) =>
                  `  * ${s.label}: ${s.price.toFixed(2)} (jarak -${s.distanceUsd.toFixed(
                    2
                  )} USD / ${s.distanceAtr} ATR di bawah harga sekarang)`
              )
              .join('\n')
          : '  * Belum ada cluster Support terdekat di bawah harga saat ini (area breakdown baru).';

      const fvgLines =
        chartStructure.fvgZones.length > 0
          ? chartStructure.fvgZones
              .map((f) => `${f.type} [${f.low.toFixed(2)} - ${f.high.toFixed(2)}]`)
              .join(' | ')
          : 'Tidak ada FVG aktif terdekat';

      const fiboLine = ind.fibonacci
        ? `Trend ${ind.fibonacci.trend} (${ind.fibonacci.swingLow.toFixed(
            2
          )}-${ind.fibonacci.swingHigh.toFixed(2)}) | 38.2%=${ind.fibonacci.r382} | 50%=${
            ind.fibonacci.r500
          } | 61.8%=${ind.fibonacci.r618} | 78.6%=${ind.fibonacci.r786} | Ext 127.2%=${
            ind.fibonacci.ext1272
          } | Ext 161.8%=${ind.fibonacci.ext1618}`
        : 'N/A';

      const macroLines = [
        `DXY (DX-Y.NYB): ${macroContext.dxyPrice ?? 'N/A'} (${
          macroContext.dxyChangePct !== null
            ? `${macroContext.dxyChangePct >= 0 ? '+' : ''}${macroContext.dxyChangePct}%`
            : 'N/A'
        }) -> ${macroContext.dxyBias} (Korelasi Invers XAU/USD)`,
        `US 10Y Yield (^TNX): ${macroContext.us10yYield ?? 'N/A'}% (${
          macroContext.us10yChangePct !== null
            ? `${macroContext.us10yChangePct >= 0 ? '+' : ''}${macroContext.us10yChangePct}%`
            : 'N/A'
        }) | S&P 500 (^GSPC): ${macroContext.sp500Price ?? 'N/A'} (${
          macroContext.sp500ChangePct !== null
            ? `${macroContext.sp500ChangePct >= 0 ? '+' : ''}${macroContext.sp500ChangePct}%`
            : 'N/A'
        })`,
        ...(macroContext.headlines.length > 0
          ? macroContext.headlines.map(
              (h, idx) => `Berita #${idx + 1} [${h.source}]: ${h.title}`
            )
          : ['Belum ada headline geopolitik baru yang termuat saat ini.']),
      ].join('\n');

      const lossTrades = recentClosedList.filter((t) => t.pnlUsd < 0);
      const selfAuditSection =
        recentClosedList.length > 0
          ? `\nSELF-AUDIT KESALAHAN & RIWAYAT TRADE TERAKHIR (WAJIB DIPELAJARI):
${recentClosedList
  .map(
    (t, idx) =>
      `  * Trade #${idx + 1}: ${t.side} @ ${t.entryPrice.toFixed(2)} -> ${
        t.closeReason
      } @ ${t.closePrice.toFixed(2)} (${t.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(
        t.pnlUsd
      ).toFixed(2)}, ${t.closedMinutesAgo}m lalu)`
  )
  .join('\n')}
${
  lossTrades.length > 0
    ? `- PERINGATAN SELF-CORRECTION: Ditemukan ${lossTrades.length} trade rugi terbaru. Identifikasi penyebab (entry menabrak S/R, false breakout, melawan DXY, atau tergesa-gesa) dan JANGAN ulangi pola kesalahan yang sama.`
    : '- Catatan: Tidak ada trade rugi dalam riwayat 2 jam terakhir; tetap jaga disiplin validasi struktur.'
}`
          : '\nSELF-AUDIT KESALAHAN TERDAHULU: Belum ada riwayat trade tertutup terbaru; tetap terapkan disiplin ketat tanpa asumsi.';

      const structureSection = `PETA SUPPORT, RESISTANCE, STRUKTUR HARGA & POLA CHART (WAJIB DIBACA AGAR TIDAK BUTA HARGA):
- Struktur Pasar (${tfLabel}): ${chartStructure.marketStructure} -> ${chartStructure.structureSummary}
- Posisi Harga Terhadap S/R Terdekat: ${chartStructure.pricePositionNote}
- Level RESISTANCE (Atap / Supply di atas harga):
${resistanceLines}
- Level SUPPORT (Lantai / Demand di bawah harga):
${supportLines}
- Level Kunci Tambahan: Pivot Point=${chartStructure.pivotPoint ?? 'N/A'} | Session High=${chartStructure.sessionHigh.toFixed(2)} | Session Low=${chartStructure.sessionLow.toFixed(2)} | Angka Psikologis: ${chartStructure.roundLevels.join(', ')}
- Fibonacci Retracement & Extension: ${fiboLine}
- Pola Chart Makro Terdeteksi (20-50 candle): ${
        chartStructure.chartPatterns.length > 0
          ? chartStructure.chartPatterns.join(' | ')
          : 'Tidak ada pola kompresi/double khusus'
      }
- Pola Candlestick Terkini: ${
        chartStructure.candlestickPatterns.length > 0
          ? chartStructure.candlestickPatterns.join(' | ')
          : 'Candle reguler (evaluasi langsung body & wick di tabel OHLC)'
      }
- Zona Imbalance / Fair Value Gap (FVG): ${fvgLines}
ATURAN MEMBACA PETA HARGA & S/R:
* Jangan pernah entry "buta" menabrak tembok: hindari BUY tepat di bawah Resistance kuat (jarak < 0.35 ATR) kecuali sudah terjadi candle breakout/acceptance yang valid, dan hindari SELL tepat di atas Support kuat tanpa breakdown valid.
* Manfaatkan pantulan/rejection di Support/Resistance (misalnya Pin Bar, Engulfing, atau Liquidity Sweep di S1/R1) serta targetkan Take Profit di dekat level S/R atau zona likuiditas berikutnya.`;

      const adaptivePromptRule =
        strategyFocus === 'ADAPTIVE_SCALP'
          ? `\nATURAN GABUNGAN AUTO ADAPTIVE (TARGET WINRATE >80% & PROFITABLE):\n- Anda menggabungkan 2 engine: (A) [Momentum M5] EMA 9/21/50 + Tight ATR, dan (B) [Sniper M1+M5] Ultra-Scalping Sniper Breakout. Pilih otomatis mode yang paling cocok dengan kondisi pasar saat ini.\n- Gunakan [Momentum M5] saat tren bersih (EMA 9/21/50 searah & slope jelas, ADX mendukung, pullback sehat ke EMA9/21).\n- Gunakan [Sniper M1+M5] saat terjadi breakout kompresi / liquidity sweep dengan konfirmasi micro candle & penolakan S/R kunci.\n- WAJIB disiplin target Winrate >80% (di atas 80%): hanya keluarkan BUY/SELL jika konfluensi solid dan jalur ke TP1 bebas dari tembok S/R penghalang; jika choppy/meragukan atau peluang ≤80%, WAJIB jawab HOLD.\n- Sebutkan pilihan mode ([Momentum M5] atau [Sniper M1+M5]) secara eksplisit di setupPattern dan judgeVerdict.`
          : '';

      const promptText = `Anda adalah TRADER & HAKIM KEPUTUSAN AI MANDIRI (100% Autonomous AI Sovereign Decision Maker) untuk XAU/USD.${adaptivePromptRule}
PRINSIP KERJA WAJIB AI:
1. PENGLIHATAN OPTIK OTOMATIS DARI LIVE CHART (OCR & COMPUTER VISION) + SINKRONISASI GANDA:
   - Baca gambar visual live chart yang diambil otomatis (panel Bid/Ask, garis S1/R1, struktur candlestick, dan label harga sumbu-Y), lalu selaraskan dengan Konsensus Harga Global Real-Time di bawah!
   - Protokol Sinkronisasi Global Saat Ini: ${globalSync.summary}
2. FUNDAMENTAL HARIAN, DXY, SAHAM & GEOPOLITIK REAL-TIME:
${macroLines}
   - Selaraskan analisa teknikal dengan arah DXY (korelasi invers), Yield US10Y, S&P 500, dan berita geopolitik di atas.
3. SELF-AUDIT KESALAHAN TERDAHULU & KEJUJURAN DATA (ANTI-INFLASI CONFIDENCE):
   - DILARANG KERAS memberikan angka keyakinan palsu (95%–100% atau 98%) jika pasar sedang ranging, ADX < 20, multi-timeframe bentrok, atau belum ada konfirmasi struktur yang solid.
   - Jika tidak ada konfirmasi kuat, JUJUR keluarkan "HOLD" dengan skor keyakinan realistis (40–68%).
4. ANALISA LINTAS TIMEFRAME (M5 → M15 → M30 → H1 → H4) & URUTAN CANDLE (KIRI KE KANAN):
${mtfData.promptBlock}

DATA HARGA PASAR REAL-TIME (UTAMA):
- Pair: XAU/USD (Timeframe Utama: ${tfLabel}${m1Section ? ' + M1 Micro' : ''})
- Sumber Feed Utama: ${snapshot.quote.source}
- Bid: ${snapshot.quote.bid} | Ask: ${snapshot.quote.ask} | Mid: ${snapshot.quote.mid} | Spread: ${spreadInfo}
- High 24h: ${snapshot.quote.high24h} | Low 24h: ${snapshot.quote.low24h}
- Sisa waktu penutupan candle ${tfLabel} aktif: ${snapshot.quote.candleCloseInSec} detik

${structureSection}

30 CANDLE ${tfLabel} TERAKHIR (URUTAN KIRI KE KANAN — Body=ukuran body, UW=ekor atas, LW=ekor bawah):
${candleTable}
${m1Section}
ANALISA POLA SEKUENSIAL & ORDER FLOW (${snapshot.candles.length} CANDLE):
${deepLearningTelemetry}

INDIKATOR TEKNIKAL (PENUNJANG KONFLUENSI — BUKAN PENENTU TUNGGAL):
- EMA 9: ${ind.ema9 ?? 'N/A'} (Slope 3-bar: ${ema9Slope !== null ? `${ema9Slope >= 0 ? '+' : ''}${ema9Slope}` : 'N/A'})
- EMA 21: ${ind.ema21 ?? 'N/A'} (Gap EMA9-EMA21: ${emaGap !== null ? `${emaGap >= 0 ? '+' : ''}${emaGap}` : 'N/A'})
- EMA 50: ${ind.ema50 ?? 'N/A'} | EMA 200: ${ind.ema200 ?? 'N/A'}
- RSI (14): ${ind.rsi14 ?? 'N/A'} | Stochastic (14,3,3): %K=${ind.stochastic?.k ?? 'N/A'}, %D=${ind.stochastic?.d ?? 'N/A'}
- ADX (14): ${ind.adx14 ?? 'N/A'} (>20 trend kuat, <20 ranging) | OBV Volume Trend: ${ind.obvTrend ?? 'NEUTRAL'}
- MACD (12,26,9): Line=${ind.macd.line ?? 'N/A'}, Signal=${ind.macd.signal ?? 'N/A'}, Hist=${ind.macd.histogram ?? 'N/A'}
- ATR (14): ${atrValue} USD (Info volatilitas saja — opsi jarak referensi: SL ~$${slGuide}, TP1 ~$${tpGuide})
- Bollinger Bands (20,2): Upper=${ind.bollinger.upper ?? 'N/A'}, Mid=${ind.bollinger.middle ?? 'N/A'}, Lower=${ind.bollinger.lower ?? 'N/A'}
- Swing High (30 candle): ${ind.swingHigh} | Swing Low (30 candle): ${ind.swingLow}

KONTEKS AKUN & GAYA EKSEKUSI:
- Preferensi Gaya Trader: ${strategyFocus} (${strategyInstructionMap[strategyFocus] || strategyInstructionMap.ADAPTIVE_SCALP})
- Mode Penalaran AI: ${thinkingHigh ? 'DEEP LEARNING + THINKING HIGH' : 'STANDARD'} | Engine Dipilih: ${requestedProvider}
- Mode Otoritas: ${fullAiControl ? '100% KEPUTUSAN MANDIRI AI (Vonis Anda langsung dieksekusi tanpa filter)' : 'AI Judge + Filter Confidence'}
- Proteksi Exit: ${noSlAiExit ? '100% MURNI TANPA SL (SL order = 0, TP tetap aktif, AI mandiri menentukan cut-loss/exit jika arah berbalik)' : 'Stop Loss Standar Broker'}
- Saldo Akun: $${body.accountBalance ?? 10000} | Risk/Trade: ${body.riskPercent ?? 1}%
${selfAuditSection}
${positionMonitorInstruction}
${postTpInstruction}

TUGAS KEPUTUSAN MANDIRI AI:
1. Lakukan OCR/Computer Vision terhadap gambar live chart yang dikirim (baca label Bid/Ask, S1/R1, & sumbu-Y) dan sinkronkan dengan harga Konsensus Global (${globalSync.consensusMid}).
2. Baca Peta Support/Resistance, Fibonacci, Struktur MTF (M5–H4), Order Flow, serta DXY & Geopolitik sebelum memutuskan "BUY", "SELL", atau "HOLD".
3. Terapkan KEJUJURAN DATA: jangan pernah memaksakan skor 90–98% jika struktur tidak terkonfirmasi penuh.
4. Tentukan \`entryPrice\`, \`stopLoss\` (di balik level S/R / batas invalidasi struktur), \`takeProfit1\`, dan \`takeProfit2\` (BUY: stopLoss < entryPrice < takeProfit1 < takeProfit2; SELL: stopLoss > entryPrice > takeProfit1 > takeProfit2).
5. Jika memilih "HOLD": isi entryPrice dengan harga mid saat ini (${snapshot.quote.mid}).
6. Isi \`ocrExtractedPrice\`, \`globalSyncSummary\`, \`macroSummary\`, \`mtfSummary\`, \`keyLevelsSummary\`, \`postTpEvaluation\`, \`postTpReason\`, \`judgeVerdict\`, dan \`indicatorWeighting\` dalam Bahasa Indonesia berdasarkan FAKTA data di atas.`;

      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [];

      let usedChartVision = false;
      let chartImageBase64Cleaned: string | undefined;

      if (body.chartImageBase64 && typeof body.chartImageBase64 === 'string') {
        const cleaned = body.chartImageBase64.replace(/^data:image\/[\w+.-]+;base64,/i, '');
        if (cleaned.length > 100) {
          chartImageBase64Cleaned = cleaned;
          parts.push({
            inlineData: {
              mimeType: 'image/png',
              data: cleaned,
            },
          });
          usedChartVision = true;
        }
      }
      parts.push({ text: promptText });

      const systemInstruction =
        'Anda adalah Analis & Hakim Keputusan AI Profesional untuk XAU/USD yang jujur terhadap data. Anda WAJIB membaca visual live chart secara otomatis (OCR Bid/Ask & sumbu-Y), menyelaraskan dengan Konsensus Harga Global, memeriksa DXY & berita geopolitik real-time, memetakan S/R + Fibonacci + MTF (M5-H4) dari kiri ke kanan, mengaudit riwayat trade rugi agar tidak terulang, dan DILARANG menggelembungkan confidence (95-98%) bila struktur belum terkonfirmasi penuh. Saat pasca-TP, jangan membuka posisi balik arah spontan tanpa konfirmasi struktur.';

      let rawText = '';
      let activeModelName = thinkingHigh ? 'gemini-4-hydrogen (Thinking High)' : 'gemini-4-hydrogen';

      const geminiKeys = getConfiguredGeminiKeys();
      const airforceCfg = getAirforceConfig();
      const openRouterCfg = getOpenRouterDecisionsConfig();

      const runGeminiEngine = async (
        allowFastFail: boolean,
        modelName: 'gemini-4-hydrogen' | 'gemini-4-argon' = 'gemini-4-hydrogen'
      ) => {
        const { response } = await generateWithGeminiFallback(
          {
            model: modelName,
            contents: { parts },
            config: {
              systemInstruction,
              thinkingConfig: {
                thinkingLevel: thinkingHigh ? ThinkingLevel.HIGH : ThinkingLevel.MEDIUM,
              },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  signal: {
                    type: Type.STRING,
                    description: 'Vonis keputusan final AI Judge: BUY, SELL, atau HOLD',
                  },
                  confidence: {
                    type: Type.NUMBER,
                    description: 'Skor keyakinan hakim AI 0 sampai 100',
                  },
                  marketBias: {
                    type: Type.STRING,
                    description: 'Bias struktur chart: BULLISH, BEARISH, atau RANGING',
                  },
                  positionDecision: {
                    type: Type.STRING,
                    description:
                      'Keputusan terhadap posisi terbuka: NONE (jika tidak ada posisi), KEEP (jika peluang win >= 20% atau keyakinan balik arah < 80%), atau CLOSE_ALL/CLOSE_BUY/CLOSE_SELL HANYA jika winProbability < 20 DAN reversalConfidence >= 80',
                  },
                  positionReason: {
                    type: Type.STRING,
                    description:
                      'Alasan singkat keputusan AI atas posisi terbuka termasuk estimasi peluang win (%) dan keyakinan pembalikan arah (%)',
                  },
                  winProbability: {
                    type: Type.NUMBER,
                    description:
                      'Estimasi peluang win posisi terbuka mencapai TP (0 sampai 100)',
                  },
                  reversalConfidence: {
                    type: Type.NUMBER,
                    description:
                      'Tingkat keyakinan adanya indikasi harga berubah arah melawan posisi terbuka (0 sampai 100)',
                  },
                  highProbTp: {
                    type: Type.NUMBER,
                    description:
                      'Target Take Profit gabungan yang realistis untuk kedua posisi (posisi lama + martil/layer searah) dengan probabilitas tersentuh minimal 85%',
                  },
                  highProbTpConfidence: {
                    type: Type.NUMBER,
                    description:
                      'Estimasi probabilitas highProbTp akan tersentuh (85 sampai 99 jika ada posisi searah, atau 0 jika tidak ada)',
                  },
                  postTpEvaluation: {
                    type: Type.STRING,
                    description:
                      'Evaluasi situasi pasca-TP: NONE (jika belum ada TP/close terbaru), RE_ENTRY_CONTINUATION (harga lanjut kuat & aman re-entry searah meski indikator jenuh), WAIT_PULLBACK_HOLD (tahan HOLD tunggu pullback sehat/jangan FOMO atau asal balik arah), atau EXHAUSTION_SKIP (momentum jenuh/trap, wajib HOLD)',
                  },
                  postTpReason: {
                    type: Type.STRING,
                    description:
                      'Penjelasan situasional AI pasca-TP (pertimbangan overbought/oversold vs kelanjutan momentum, FOMO, & alasan tidak asal buka posisi balik arah)',
                  },
                  keyLevelsSummary: {
                    type: Type.STRING,
                    description:
                      'Ringkasan peta Support/Resistance (S1/R1), struktur pasar (HH/HL/LH/LL/BOS), dan chart/candlestick pattern yang dibaca AI',
                  },
                  judgeVerdict: {
                    type: Type.STRING,
                    description:
                      'Kalimat vonis tegas AI Judge (contoh: VONIS AI: BUY — Rejection Pin Bar di S1 dengan ruang ke R1)',
                  },
                  indicatorWeighting: {
                    type: Type.STRING,
                    description:
                      'Penjelasan singkat bagaimana AI Judge menimbang fitur Deep Learning & data mentah indikator (EMA, RSI, MACD, ATR, spread)',
                  },
                  entryPrice: {
                    type: Type.NUMBER,
                    description: 'Harga entry optimal saat ini dalam USD',
                  },
                  stopLoss: {
                    type: Type.NUMBER,
                    description: 'Level batas invalidasi struktur dalam USD (referensi risk lot)',
                  },
                  takeProfit1: {
                    type: Type.NUMBER,
                    description: 'Target Take Profit 1 scalping cepat dalam USD',
                  },
                  takeProfit2: {
                    type: Type.NUMBER,
                    description: 'Target Take Profit 2 lanjutan dalam USD',
                  },
                  riskRewardRatio: {
                    type: Type.STRING,
                    description: 'Rasio Risk to Reward, contoh: 1:1.4',
                  },
                  setupPattern: {
                    type: Type.STRING,
                    description: 'Nama pola atau setup utama (singkat)',
                  },
                  summary: {
                    type: Type.STRING,
                    description: 'Analisa ringkas 2-3 kalimat dalam Bahasa Indonesia',
                  },
                  keyFactors: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: '3-4 poin bukti utama yang dipakai AI Judge untuk menjatuhkan vonis',
                  },
                  invalidatedIf: {
                    type: Type.STRING,
                    description: 'Kondisi harga yang membatalkan vonis analisa ini',
                  },
                  ocrExtractedPrice: {
                    type: Type.STRING,
                    description:
                      'Hasil pembacaan OCR harga Bid/Ask & sumbu Y dari gambar chart atau screenshot MT5',
                  },
                  globalSyncSummary: {
                    type: Type.STRING,
                    description:
                      'Ringkasan sinkronisasi harga gambar/broker dengan konsensus pasar global real-time',
                  },
                  macroSummary: {
                    type: Type.STRING,
                    description:
                      'Ringkasan korelasi DXY, Yield US10Y, S&P 500, dan berita geopolitik/fundamental harian terkait Gold',
                  },
                  mtfSummary: {
                    type: Type.STRING,
                    description:
                      'Ringkasan keselarasan struktur lintas timeframe M5 -> M15 -> M30 -> H1 -> H4',
                  },
                },
                required: [
                  'signal',
                  'confidence',
                  'marketBias',
                  'positionDecision',
                  'positionReason',
                  'winProbability',
                  'reversalConfidence',
                  'postTpEvaluation',
                  'postTpReason',
                  'keyLevelsSummary',
                  'judgeVerdict',
                  'indicatorWeighting',
                  'entryPrice',
                  'stopLoss',
                  'takeProfit1',
                  'takeProfit2',
                  'riskRewardRatio',
                  'setupPattern',
                  'summary',
                  'keyFactors',
                  'invalidatedIf',
                ],
              },
            },
          },
          { fastFailWhenAllCooldown: allowFastFail }
        );
        rawText = (response.text ?? '').trim();
        activeModelName = thinkingHigh ? `${modelName} (Thinking High)` : modelName;
      };

      const runAirforceEngine = async (cfg: AirforceConfig) => {
        const resAir = await generateAnalysisViaAirforce({
          cfg,
          systemInstruction,
          promptText,
          thinkingHigh,
        });
        rawText = resAir.rawText;
        usedChartVision = false;
        activeModelName = resAir.model;
      };

      const invokeOpenRouterDecisions = async (
        cfg: OpenRouterDecisionsConfig,
        decisionModel?: string,
        timeoutMs?: number
      ) => {
        return generateAnalysisViaOpenRouterDecisions({
          cfg,
          modelOverride: decisionModel,
          timeoutMs,
          systemInstruction,
          promptText,
          chartImageBase64: chartImageBase64Cleaned,
          snapshot,
          chartStructure,
          atrValue,
          isScalpMode,
          openPositionsCount,
          hasRecentClosedContext: Boolean(latestClosed && latestClosed.closedMinutesAgo <= 90),
        });
      };

      const runOpenRouterDecisionsEngine = async (
        cfg: OpenRouterDecisionsConfig,
        decisionModel?: string,
        timeoutMs?: number
      ) => {
        const resOr = await invokeOpenRouterDecisions(cfg, decisionModel, timeoutMs);
        rawText = resOr.rawText;
        usedChartVision = resOr.usedChartVision;
        activeModelName = resOr.model;
      };

      const runOpenRouterRespanPplxAlternating = async (cfg: OpenRouterDecisionsConfig) => {
        const idx = respanPplxCursor % 2;
        respanPplxCursor = (respanPplxCursor + 1) % 2;
        let primaryModel = idx === 0 ? cfg.respanModel : cfg.model;
        let secondaryModel = idx === 0 ? cfg.model : cfg.respanModel;

        const nowMs = Date.now();
        const primaryCooling =
          (airforceEngineCooldownUntil.get(`or-dual:${primaryModel}`) ?? 0) > nowMs;
        const secondaryCooling =
          (airforceEngineCooldownUntil.get(`or-dual:${secondaryModel}`) ?? 0) > nowMs;
        if (primaryCooling && !secondaryCooling) {
          const tmp = primaryModel;
          primaryModel = secondaryModel;
          secondaryModel = tmp;
        }

        const SLOW_TAKEOVER_MS = 10_000;
        let settled = false;
        let slowTimer: ReturnType<typeof setTimeout> | null = null;
        let triggerSecondary: (() => void) | null = null;

        const primaryPromise = invokeOpenRouterDecisions(cfg, primaryModel, 26_000).then(
          (res) => {
            settled = true;
            if (slowTimer) {
              clearTimeout(slowTimer);
              slowTimer = null;
            }
            airforceEngineCooldownUntil.delete(`or-dual:${primaryModel}`);
            return res;
          },
          (err) => {
            airforceEngineCooldownUntil.set(`or-dual:${primaryModel}`, Date.now() + 30_000);
            console.warn(
              `[Dual Span-01/PPLX] ${primaryModel} gagal (${
                err instanceof Error ? err.message : String(err)
              }). Mengambil alih ke ${secondaryModel}...`
            );
            triggerSecondary?.();
            throw err;
          }
        );

        const secondaryPromise = new Promise<{
          rawText: string;
          model: string;
          usedChartVision: boolean;
        }>((resolve, reject) => {
          let started = false;
          const startSecondary = () => {
            if (started || settled) return;
            started = true;
            if (slowTimer) {
              clearTimeout(slowTimer);
              slowTimer = null;
            }
            invokeOpenRouterDecisions(cfg, secondaryModel, 24_000).then(
              (res) => {
                settled = true;
                airforceEngineCooldownUntil.delete(`or-dual:${secondaryModel}`);
                resolve(res);
              },
              (err) => {
                airforceEngineCooldownUntil.set(`or-dual:${secondaryModel}`, Date.now() + 30_000);
                reject(err);
              }
            );
          };

          triggerSecondary = startSecondary;
          slowTimer = setTimeout(() => {
            if (!settled) {
              console.warn(
                `[Dual Span-01/PPLX] ${primaryModel} lambat (>10s). Mengambil alih paralel dengan ${secondaryModel}...`
              );
              startSecondary();
            }
          }, SLOW_TAKEOVER_MS);
        });

        // Prevent unhandled rejection if primary finishes first before secondary ever starts
        secondaryPromise.catch(() => {});

        try {
          const winner = await Promise.any([primaryPromise, secondaryPromise]);
          rawText = winner.rawText;
          usedChartVision = winner.usedChartVision;
          activeModelName = winner.model;
        } catch (aggErr) {
          if (slowTimer) {
            clearTimeout(slowTimer);
            slowTimer = null;
          }
          if (aggErr instanceof AggregateError && aggErr.errors.length > 0) {
            throw aggErr.errors[aggErr.errors.length - 1];
          }
          throw aggErr;
        }
      };

      const runOpenRouterChatEngine = async (
        cfg: OpenRouterDecisionsConfig,
        modelName: string
      ) => {
        const resOrChat = await generateAnalysisViaOpenRouterChat({
          cfg,
          modelName,
          systemInstruction,
          promptText,
          chartImageBase64: chartImageBase64Cleaned,
          thinkingHigh,
        });
        rawText = resOrChat.rawText;
        usedChartVision = resOrChat.usedChartVision;
        activeModelName = resOrChat.model;
      };

      interface AiCandidate {
        key: string;
        label: string;
        run: (allowFastFail: boolean) => Promise<void>;
      }

      const candidates: AiCandidate[] = [];
      if (geminiKeys.length > 0) {
        candidates.push({
          key: 'gemini-hydrogen',
          label: 'Gemini 4 Hydrogen',
          run: (allowFastFail) => runGeminiEngine(allowFastFail, 'gemini-4-hydrogen'),
        });
        candidates.push({
          key: 'gemini-argon',
          label: 'Gemini 4 Argon',
          run: (allowFastFail) => runGeminiEngine(allowFastFail, 'gemini-4-argon'),
        });
      }
      if (airforceCfg) {
        candidates.push({
          key: 'airforce',
          label: `Airforce (${airforceCfg.model})`,
          run: () => runAirforceEngine(airforceCfg),
        });
      }
      if (openRouterCfg) {
        candidates.push(
          {
            key: 'openrouter-heygen',
            label: `OpenRouter (${openRouterCfg.heygenModel})`,
            run: () => runOpenRouterDecisionsEngine(openRouterCfg, openRouterCfg.heygenModel),
          },
          {
            key: 'openrouter-drex',
            label: `OpenRouter (${openRouterCfg.drexModel})`,
            run: () => runOpenRouterDecisionsEngine(openRouterCfg, openRouterCfg.drexModel),
          },
          {
            key: 'openrouter-jev',
            label: `OpenRouter (${openRouterCfg.jevModel})`,
            run: () => runOpenRouterDecisionsEngine(openRouterCfg, openRouterCfg.jevModel),
          },
          {
            key: 'openrouter-respan',
            label: `OpenRouter (${openRouterCfg.respanModel})`,
            run: () => runOpenRouterDecisionsEngine(openRouterCfg, openRouterCfg.respanModel),
          },
          {
            key: 'openrouter-pplx',
            label: `OpenRouter (${openRouterCfg.model})`,
            run: () => runOpenRouterDecisionsEngine(openRouterCfg, openRouterCfg.model),
          },
          {
            key: 'openrouter-argon',
            label: `OpenRouter (${openRouterCfg.argonModel})`,
            run: () => runOpenRouterChatEngine(openRouterCfg, openRouterCfg.argonModel),
          },
          {
            key: 'openrouter-hydrogen',
            label: `OpenRouter (${openRouterCfg.hydrogenModel})`,
            run: () => runOpenRouterChatEngine(openRouterCfg, openRouterCfg.hydrogenModel),
          },
          {
            key: 'openrouter-nemotron',
            label: `OpenRouter (${openRouterCfg.nemotronModel})`,
            run: () => runOpenRouterChatEngine(openRouterCfg, openRouterCfg.nemotronModel),
          },
          {
            key: 'openrouter-kimi',
            label: `OpenRouter (${openRouterCfg.kimiModel})`,
            run: () => runOpenRouterChatEngine(openRouterCfg, openRouterCfg.kimiModel),
          }
        );
      }

      const runPool = async (poolList: AiCandidate[], roundRobin: boolean) => {
        if (poolList.length === 0) {
          throw new Error(
            'Belum ada API key AI yang aktif. Tambahkan GEMINI_API_KEY, AIRFORCE_API_KEY, atau OPENROUTER_API_KEY di Settings > Secrets.'
          );
        }
        let ordered = [...poolList];
        if (roundRobin && ordered.length > 1) {
          const offset = aiRoundRobinCursor % ordered.length;
          aiRoundRobinCursor = (aiRoundRobinCursor + 1) % ordered.length;
          ordered = [...ordered.slice(offset), ...ordered.slice(0, offset)];
        }
        const now = Date.now();
        const ready = ordered.filter((c) => (airforceEngineCooldownUntil.get(c.key) ?? 0) <= now);
        const cooling = ordered
          .filter((c) => (airforceEngineCooldownUntil.get(c.key) ?? 0) > now)
          .sort(
            (a, b) =>
              (airforceEngineCooldownUntil.get(a.key) ?? 0) -
              (airforceEngineCooldownUntil.get(b.key) ?? 0)
          );
        const prioritized = [...ready, ...cooling];

        let lastErr: unknown = null;
        for (let i = 0; i < prioritized.length; i++) {
          const c = prioritized[i];
          const hasMore = i < prioritized.length - 1;
          try {
            await c.run(hasMore);
            airforceEngineCooldownUntil.delete(c.key);
            return;
          } catch (err) {
            lastErr = err;
            const isMissingModel =
              err instanceof OpenRouterError &&
              (err.statusCode === 404 ||
                (err.statusCode === 400 && /does not exist|not found|unknown model/i.test(err.detail)));
            const isBadModelPayload =
              err instanceof SyntaxError ||
              (err instanceof OpenRouterError && err.statusCode === 502 && /JSON valid/i.test(err.detail));
            if (isEngineFailureEligibleForRotation(err) || isMissingModel || isBadModelPayload) {
              airforceEngineCooldownUntil.set(c.key, Date.now() + 60_000);
            }
            if (hasMore && (isEngineFailureEligibleForRotation(err) || isMissingModel || isBadModelPayload)) {
              console.warn(
                `[AI Rotation] ${c.label} gagal/limit (${
                  err instanceof Error ? err.message : String(err)
                }). Beralih ke ${prioritized[i + 1].label}...`
              );
              continue;
            }
            throw err;
          }
        }
        if (lastErr) throw lastErr;
      };

      const requireOpenRouter = () => {
        if (!openRouterCfg) {
          throw new Error(
            'OPENROUTER_API_KEY belum terkonfigurasi di Settings > Secrets.'
          );
        }
        return openRouterCfg;
      };

      if (requestedProvider === 'GEMINI') {
        const geminiOnly = candidates.filter((c) => c.key.startsWith('gemini-'));
        await runPool(
          geminiOnly.length > 0
            ? geminiOnly
            : [
                {
                  key: 'gemini-hydrogen',
                  label: 'Gemini 4 Hydrogen',
                  run: (allowFastFail) => runGeminiEngine(allowFastFail, 'gemini-4-hydrogen'),
                },
              ],
          false
        );
      } else if (requestedProvider === 'AIRFORCE') {
        if (!airforceCfg) {
          throw new Error(
            'AIRFORCE_API_KEY belum terkonfigurasi di Settings > Secrets. Tambahkan AIRFORCE_API_KEY untuk memakai server Airforce (deepseek-v3).'
          );
        }
        await runAirforceEngine(airforceCfg);
      } else if (requestedProvider === 'OPENROUTER') {
        requireOpenRouter();
        await runPool(
          candidates.filter((c) => c.key.startsWith('openrouter-')),
          false
        );
      } else if (requestedProvider === 'OPENROUTER_RESPAN') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterDecisionsEngine(cfgOr, cfgOr.respanModel);
      } else if (requestedProvider === 'OPENROUTER_RESPAN_PPLX') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterRespanPplxAlternating(cfgOr);
      } else if (requestedProvider === 'OPENROUTER_HEYGEN') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterDecisionsEngine(cfgOr, cfgOr.heygenModel);
      } else if (requestedProvider === 'OPENROUTER_DREX') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterDecisionsEngine(cfgOr, cfgOr.drexModel);
      } else if (requestedProvider === 'OPENROUTER_JEV') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterDecisionsEngine(cfgOr, cfgOr.jevModel);
      } else if (requestedProvider === 'OPENROUTER_PPLX') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterDecisionsEngine(cfgOr, cfgOr.model);
      } else if (requestedProvider === 'OPENROUTER_ARGON') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterChatEngine(cfgOr, cfgOr.argonModel);
      } else if (requestedProvider === 'OPENROUTER_HYDROGEN') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterChatEngine(cfgOr, cfgOr.hydrogenModel);
      } else if (requestedProvider === 'OPENROUTER_NEMOTRON') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterChatEngine(cfgOr, cfgOr.nemotronModel);
      } else if (requestedProvider === 'OPENROUTER_KIMI') {
        const cfgOr = requireOpenRouter();
        await runOpenRouterChatEngine(cfgOr, cfgOr.kimiModel);
      } else if (requestedProvider === 'ROUND_ROBIN') {
        await runPool(candidates, true);
      } else {
        await runPool(candidates, false);
      }

      if (!rawText) {
        throw new Error('Endpoint AI tidak mengembalikan output analisa.');
      }

      const parsed = JSON.parse(extractJsonObjectString(rawText)) as {
        signal: string;
        confidence: number;
        marketBias: string;
        positionDecision?: string;
        positionReason?: string;
        winProbability?: number;
        reversalConfidence?: number;
        highProbTp?: number;
        highProbTpConfidence?: number;
        postTpEvaluation?: string;
        postTpReason?: string;
        keyLevelsSummary?: string;
        judgeVerdict: string;
        indicatorWeighting: string;
        entryPrice: number;
        stopLoss: number;
        takeProfit1: number;
        takeProfit2: number;
        riskRewardRatio: string;
        setupPattern: string;
        summary: string;
        keyFactors: string[];
        invalidatedIf: string;
        ocrExtractedPrice?: string;
        globalSyncSummary?: string;
        macroSummary?: string;
        mtfSummary?: string;
      };

      const rawSig = String(parsed.signal || '').toUpperCase().trim();
      let normalizedSignal: 'BUY' | 'SELL' | 'HOLD' =
        rawSig === 'BUY' || rawSig === 'LONG'
          ? 'BUY'
          : rawSig === 'SELL' || rawSig === 'SHORT'
          ? 'SELL'
          : 'HOLD';
      const rawBias = String(parsed.marketBias || '').toUpperCase();
      const normalizedBias = /BULL/i.test(rawBias)
        ? 'BULLISH'
        : /BEAR/i.test(rawBias)
        ? 'BEARISH'
        : 'RANGING';

      const parsedWinProb = Number(parsed.winProbability);
      const parsedRevConf = Number(parsed.reversalConfidence);
      const winProbability =
        openPositionsCount > 0 && Number.isFinite(parsedWinProb)
          ? Math.max(0, Math.min(100, Math.round(parsedWinProb)))
          : undefined;
      const reversalConfidence =
        openPositionsCount > 0 && Number.isFinite(parsedRevConf)
          ? Math.max(0, Math.min(100, Math.round(parsedRevConf)))
          : undefined;

      const rawPosDecision = (parsed.positionDecision || '').toUpperCase().trim();
      let normalizedPosDecision: PositionDecision = 'NONE';
      let posGuardNote = '';
      if (openPositionsCount > 0) {
        const wantsClose =
          rawPosDecision === 'CLOSE_BUY' ||
          rawPosDecision === 'CLOSE_SELL' ||
          rawPosDecision === 'CLOSE_ALL';
        const meetsStrictExitRule =
          winProbability !== undefined &&
          reversalConfidence !== undefined &&
          winProbability < 20 &&
          reversalConfidence >= 80;

        if (wantsClose && meetsStrictExitRule) {
          normalizedPosDecision = rawPosDecision as PositionDecision;
        } else {
          normalizedPosDecision = 'KEEP';
          if (wantsClose && !meetsStrictExitRule) {
            posGuardNote = ` [Guard AI Exit Judge menahan KEEP: peluang win ${
              winProbability ?? 'N/A'
            }% (syarat <20%) & keyakinan balik arah ${
              reversalConfidence ?? 'N/A'
            }% (syarat ≥80%)]`;
          }
        }
      }

      // Anti-Contradiction / Anti-Hedging Guard:
      // Never emit BUY while an open SELL remains KEEP, and never emit SELL while an open BUY remains KEEP.
      let antiHedgeNote = '';
      if (openPositionsCount > 0) {
        const detailList = Array.isArray(body.openPositionsDetail) ? body.openPositionsDetail : [];
        const summaryText = String(body.openPositionsSummary || '');
        const hasOpenBuy =
          detailList.some((p) => p.side === 'BUY') ||
          (detailList.length === 0 && /\bBUY\b/i.test(summaryText));
        const hasOpenSell =
          detailList.some((p) => p.side === 'SELL') ||
          (detailList.length === 0 && /\bSELL\b/i.test(summaryText));

        const buyRemainsOpen =
          hasOpenBuy &&
          normalizedPosDecision !== 'CLOSE_ALL' &&
          normalizedPosDecision !== 'CLOSE_BUY';
        const sellRemainsOpen =
          hasOpenSell &&
          normalizedPosDecision !== 'CLOSE_ALL' &&
          normalizedPosDecision !== 'CLOSE_SELL';

        if (
          (normalizedSignal === 'BUY' && sellRemainsOpen) ||
          (normalizedSignal === 'SELL' && buyRemainsOpen)
        ) {
          const blockedSignal = normalizedSignal;
          const keptSide = blockedSignal === 'BUY' ? 'SELL' : 'BUY';
          normalizedSignal = 'HOLD';
          antiHedgeNote = ` [Anti-Hedging Guard: Sinyal ${blockedSignal} ditahan menjadi HOLD karena posisi ${keptSide} masih aktif (KEEP — syarat close <20% win & ≥80% balik arah belum terpenuhi).]`;
        }
      }

      const rawPostTpEval = (parsed.postTpEvaluation || '').toUpperCase().trim();
      let normalizedPostTpEval: PostTpDecision = 'NONE';
      if (latestClosed && latestClosed.closedMinutesAgo <= 90) {
        if (
          rawPostTpEval === 'RE_ENTRY_CONTINUATION' ||
          rawPostTpEval === 'WAIT_PULLBACK_HOLD' ||
          rawPostTpEval === 'EXHAUSTION_SKIP'
        ) {
          normalizedPostTpEval = rawPostTpEval;
        } else if (normalizedSignal === latestClosed.side) {
          normalizedPostTpEval = 'RE_ENTRY_CONTINUATION';
        } else {
          normalizedPostTpEval = 'WAIT_PULLBACK_HOLD';
        }
      }

      const refPrice =
        normalizedSignal === 'BUY'
          ? snapshot.quote.ask
          : normalizedSignal === 'SELL'
          ? snapshot.quote.bid
          : snapshot.quote.mid;

      // Mathematical sanity check so broker order stops / lot calculation references are never inverted
      const parsedEntry = Number(parsed.entryPrice);
      let entryPrice = Number(
        (Number.isFinite(parsedEntry) && parsedEntry > 0 ? parsedEntry : refPrice).toFixed(2)
      );
      if (Math.abs(entryPrice - refPrice) > atrValue * 2.5) {
        entryPrice = refPrice;
      }

      const slMult = isScalpMode ? 1.0 : 1.5;
      const tp1Mult = isScalpMode ? 1.35 : 2.0;
      const tp2Mult = isScalpMode ? 2.2 : 3.2;

      const parsedSl = Number(parsed.stopLoss);
      const parsedTp1 = Number(parsed.takeProfit1);
      const parsedTp2 = Number(parsed.takeProfit2);

      let stopLoss = Number(
        (Number.isFinite(parsedSl) && parsedSl > 0
          ? parsedSl
          : normalizedSignal === 'SELL'
          ? entryPrice + atrValue * slMult
          : entryPrice - atrValue * slMult
        ).toFixed(2)
      );
      let takeProfit1 = Number(
        (Number.isFinite(parsedTp1) && parsedTp1 > 0
          ? parsedTp1
          : normalizedSignal === 'SELL'
          ? entryPrice - atrValue * tp1Mult
          : entryPrice + atrValue * tp1Mult
        ).toFixed(2)
      );
      let takeProfit2 = Number(
        (Number.isFinite(parsedTp2) && parsedTp2 > 0
          ? parsedTp2
          : normalizedSignal === 'SELL'
          ? entryPrice - atrValue * tp2Mult
          : entryPrice + atrValue * tp2Mult
        ).toFixed(2)
      );

      if (normalizedSignal === 'BUY') {
        if (stopLoss >= entryPrice) stopLoss = Number((entryPrice - atrValue * slMult).toFixed(2));
        if (takeProfit1 <= entryPrice) takeProfit1 = Number((entryPrice + atrValue * tp1Mult).toFixed(2));
        if (takeProfit2 <= takeProfit1) takeProfit2 = Number((entryPrice + atrValue * tp2Mult).toFixed(2));
      } else if (normalizedSignal === 'SELL') {
        if (stopLoss <= entryPrice) stopLoss = Number((entryPrice + atrValue * slMult).toFixed(2));
        if (takeProfit1 >= entryPrice) takeProfit1 = Number((entryPrice - atrValue * tp1Mult).toFixed(2));
        if (takeProfit2 >= takeProfit1) takeProfit2 = Number((entryPrice - atrValue * tp2Mult).toFixed(2));
      }

      const positionReason =
        openPositionsCount > 0
          ? `${
              parsed.positionReason ||
              (normalizedPosDecision === 'KEEP'
                ? 'Struktur tren masih sejalan atau syarat darurat exit belum terpenuhi; biarkan TP bekerja.'
                : 'Peluang win < 20% dengan indikasi pembalikan arah ≥ 80%; eksekusi AI Exit.')
            }${posGuardNote}${antiHedgeNote}`
          : 'Tidak ada posisi terbuka.';

      const postTpReason =
        normalizedPostTpEval !== 'NONE' && latestClosed
          ? parsed.postTpReason ||
            (normalizedPostTpEval === 'RE_ENTRY_CONTINUATION'
              ? `Pasca-${latestClosed.closeReason} ${latestClosed.side}: momentum lanjutan dinilai masih solid sehingga re-entry searah layak diambil.`
              : normalizedPostTpEval === 'EXHAUSTION_SKIP'
              ? `Pasca-${latestClosed.closeReason} ${latestClosed.side}: terdeteksi kelelahan momentum/trap sehingga AI menahan diri (HOLD).`
              : `Pasca-${latestClosed.closeReason} ${latestClosed.side}: AI memilih HOLD menunggu struktur bersih & menghindari entry balik arah spontan.`)
          : 'Tidak ada konteks pasca-TP aktif.';

      const fallbackSrSummary = `${chartStructure.marketStructure} | ${chartStructure.pricePositionNote}${
        chartStructure.chartPatterns[0] ? ` | ${chartStructure.chartPatterns[0]}` : ''
      }`;

      // Data-Honesty Calibration Guard: refuse inflated 90%+ confidence when market is ranging or weak ADX
      const rawParsedConf = Number(parsed.confidence);
      const parsedConf =
        Number.isFinite(rawParsedConf) && rawParsedConf > 0 && rawParsedConf <= 1
          ? rawParsedConf * 100
          : rawParsedConf;
      let calibratedConf = Math.max(
        0,
        Math.min(100, Math.round(Number.isFinite(parsedConf) ? parsedConf : 50))
      );
      const isWeakAdx = ind.adx14 !== null && ind.adx14 !== undefined && ind.adx14 < 18;
      if (calibratedConf >= 90 && (normalizedBias === 'RANGING' || isWeakAdx || normalizedSignal === 'HOLD')) {
        calibratedConf = Math.min(calibratedConf, normalizedSignal === 'HOLD' ? 68 : 74);
      }
      let adaptiveFilterNote = '';
      if (
        strategyFocus === 'ADAPTIVE_SCALP' &&
        openPositionsCount === 0 &&
        normalizedSignal !== 'HOLD' &&
        calibratedConf <= 80
      ) {
        normalizedSignal = 'HOLD';
        adaptiveFilterNote =
          ' [Adaptive Filter WR >80%: Setup belum memenuhi syarat konfluensi di atas 80% Momentum M5 / Sniper M1+M5, ditahan menjadi HOLD.]';
      }

      const lockDir = normalizedSignal === 'SELL' ? -1 : 1;
      const tpDist = Math.abs(takeProfit1 - entryPrice);
      const lockProfitPlan = {
        lock25Price: Number((entryPrice + lockDir * tpDist * 0.25).toFixed(2)),
        lock50Price: Number((entryPrice + lockDir * tpDist * 0.5).toFixed(2)),
      };

      const dataSources = Array.from(
        new Set([
          ...globalSync.quotes.map((q) => q.source),
          ...(macroContext.dxyPrice !== null ? ['Yahoo Finance (DXY / ^TNX / ^GSPC)'] : []),
          ...macroContext.headlines.slice(0, 3).map((h) => `Berita: ${h.source}`),
        ])
      );

      const defaultMacroSummary = `DXY ${macroContext.dxyPrice ?? 'N/A'} (${
        macroContext.dxyChangePct !== null
          ? `${macroContext.dxyChangePct >= 0 ? '+' : ''}${macroContext.dxyChangePct}%`
          : 'N/A'
      }, ${macroContext.dxyBias}) · US10Y ${macroContext.us10yYield ?? 'N/A'}% · ${
        macroContext.headlines[0]?.title || 'Pantau rilis berita makro USD.'
      }`;

      // Compute High-Probability Unified TP (min >= 85% touch probability) when open positions exist
      const openDetailList = Array.isArray(body.openPositionsDetail)
        ? body.openPositionsDetail
        : [];
      const targetSideForHighTp: 'BUY' | 'SELL' | null =
        normalizedSignal !== 'HOLD'
          ? normalizedSignal
          : openPositionsCount > 0
          ? openDetailList.find((p) => p.side === 'BUY' || p.side === 'SELL')?.side ?? null
          : null;

      let highProbTp: number | undefined;
      let highProbTpConfidence: number | undefined;

      if (openPositionsCount > 0 && targetSideForHighTp) {
        const sameSideRows = openDetailList.filter((p) => p.side === targetSideForHighTp);
        const curSideLots = sameSideRows.reduce(
          (s, p) => s + Math.max(0.01, Number(p.lots) || 0.01),
          0
        );
        const curSideWeightedSum = sameSideRows.reduce(
          (s, p) => s + Number(p.entryPrice) * Math.max(0.01, Number(p.lots) || 0.01),
          0
        );
        // Project combined average assuming a 1.5x-2x martil/layer addition at current market price
        const estAddedLot = curSideLots > 0 ? curSideLots * 1.5 : 0.05;
        const projAvgEntry =
          curSideLots > 0
            ? (curSideWeightedSum + refPrice * estAddedLot) / (curSideLots + estAddedLot)
            : refPrice;

        const parsedHighTp = Number(parsed.highProbTp);
        const parsedHighTpConf = Number(parsed.highProbTpConfidence);
        const nearRes = chartStructure.nearestResistance;
        const nearSup = chartStructure.nearestSupport;

        if (targetSideForHighTp === 'BUY') {
          const maxHighProbReach = Math.min(
            snapshot.quote.ask + Math.max(0.75, atrValue * 0.72),
            nearRes && nearRes.price > snapshot.quote.ask + 0.45
              ? nearRes.price - 0.15
              : snapshot.quote.ask + Math.max(0.75, atrValue * 0.72)
          );
          const minProfitAnchor = Math.max(
            snapshot.quote.ask + Math.max(0.35, atrValue * 0.25),
            projAvgEntry + 0.35
          );
          const fallbackTp = Math.max(
            minProfitAnchor,
            Math.min(maxHighProbReach, Math.max(minProfitAnchor, snapshot.quote.ask + atrValue * 0.5))
          );
          const candidate =
            Number.isFinite(parsedHighTp) && parsedHighTp > snapshot.quote.ask + 0.25
              ? Math.min(parsedHighTp, Math.max(minProfitAnchor, maxHighProbReach))
              : fallbackTp;
          highProbTp = Number(Math.max(snapshot.quote.ask + 0.35, candidate).toFixed(2));
        } else {
          const minHighProbReach = Math.max(
            snapshot.quote.bid - Math.max(0.75, atrValue * 0.72),
            nearSup && nearSup.price < snapshot.quote.bid - 0.45
              ? nearSup.price + 0.15
              : snapshot.quote.bid - Math.max(0.75, atrValue * 0.72)
          );
          const maxProfitAnchor = Math.min(
            snapshot.quote.bid - Math.max(0.35, atrValue * 0.25),
            projAvgEntry - 0.35
          );
          const fallbackTp = Math.min(
            maxProfitAnchor,
            Math.max(minHighProbReach, Math.min(maxProfitAnchor, snapshot.quote.bid - atrValue * 0.5))
          );
          const candidate =
            Number.isFinite(parsedHighTp) && parsedHighTp < snapshot.quote.bid - 0.25
              ? Math.max(parsedHighTp, Math.min(maxProfitAnchor, minHighProbReach))
              : fallbackTp;
          highProbTp = Number(Math.min(snapshot.quote.bid - 0.35, candidate).toFixed(2));
        }

        highProbTpConfidence =
          Number.isFinite(parsedHighTpConf) && parsedHighTpConf >= 85
            ? Math.min(98, Math.round(parsedHighTpConf))
            : 88;
      }

      const analysis: EaAnalysisResult = {
        id: `ea_${Date.now()}`,
        timestamp: Date.now(),
        candleTime: lastCandle.time,
        priceAtAnalysis: snapshot.quote.mid,
        signal: normalizedSignal,
        confidence: calibratedConf,
        marketBias: normalizedBias,
        entryPrice,
        stopLoss,
        takeProfit1,
        takeProfit2,
        riskRewardRatio: parsed.riskRewardRatio || '1:1.4',
        setupPattern: antiHedgeNote
          ? 'HOLD — Jaga Posisi Aktif'
          : parsed.setupPattern || 'AI Judge Scalping Confluence',
        summary: `${parsed.summary || 'Analisa selesai.'}${antiHedgeNote}`,
        keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.slice(0, 4) : [],
        invalidatedIf: parsed.invalidatedIf || 'Break struktur candle berlawanan.',
        model: activeModelName,
        latencyMs: Date.now() - startTime,
        usedChartVision,
        judgeVerdict: antiHedgeNote
          ? `VONIS AI: HOLD (${calibratedConf}%) — Posisi aktif dipertahankan`
          : `${parsed.judgeVerdict || `VONIS AI: ${normalizedSignal} (${calibratedConf}%)`}${adaptiveFilterNote}`,
        indicatorWeighting:
          parsed.indicatorWeighting ||
          'Seluruh indikator telah ditimbang sebagai data penunjang oleh AI Judge.',
        authorityMode: fullAiControl ? 'AI_JUDGE_100' : 'CONFIDENCE_FILTER',
        positionDecision: normalizedPosDecision,
        positionReason,
        ...(winProbability !== undefined ? { winProbability } : {}),
        ...(reversalConfidence !== undefined ? { reversalConfidence } : {}),
        ...(highProbTp !== undefined ? { highProbTp } : {}),
        ...(highProbTpConfidence !== undefined ? { highProbTpConfidence } : {}),
        postTpEvaluation: normalizedPostTpEval,
        postTpReason,
        keyLevelsSummary: parsed.keyLevelsSummary || fallbackSrSummary,
        ocrExtractedPrice:
          parsed.ocrExtractedPrice ||
          `Live Chart ${snapshot.quote.source}: Bid ${snapshot.quote.bid.toFixed(
            2
          )} / Ask ${snapshot.quote.ask.toFixed(2)}`,
        globalSyncSummary: parsed.globalSyncSummary || globalSync.summary,
        macroSummary: parsed.macroSummary || defaultMacroSummary,
        mtfSummary: parsed.mtfSummary || mtfData.compactSummary,
        lockProfitPlan,
        dataSources,
      };

      const safePattern = analysis.setupPattern.replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
      const safeSummary = analysis.summary.replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
      const safePosReason = positionReason.replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
      const safePostTpReason = postTpReason.replace(/\|/g, '/').replace(/[\r\n]+/g, ' ');
      const mt5Line = [
        analysis.signal,
        analysis.confidence,
        analysis.entryPrice.toFixed(2),
        analysis.stopLoss.toFixed(2),
        analysis.takeProfit1.toFixed(2),
        analysis.takeProfit2.toFixed(2),
        safePattern,
        safeSummary,
        normalizedPosDecision,
        safePosReason,
        normalizedPostTpEval,
        safePostTpReason,
        highProbTp !== undefined ? highProbTp.toFixed(2) : '0.00',
      ].join('|');

      if (useStreamKeepAlive) {
        if (!res.writableEnded) {
          res.end(JSON.stringify({ analysis, mt5Line, snapshot }));
        }
      } else {
        res.json({ analysis, mt5Line, snapshot });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      let statusCode = 500;
      let userMessage = msg;

      if (err instanceof AirforceError) {
        statusCode = err.statusCode >= 400 ? err.statusCode : 502;
        if (err.statusCode === 401 || err.statusCode === 403) {
          userMessage = `Airforce (${err.statusCode}): ${err.detail}. Periksa AIRFORCE_API_KEY di Settings > Secrets.`;
        } else if (err.statusCode === 429 || err.statusCode === 402) {
          userMessage = `Airforce mencapai batas kuota/rate limit (${err.statusCode}): ${err.detail}`;
        } else {
          userMessage = `Airforce (${err.statusCode}): ${err.detail}`;
        }
      } else if (err instanceof OpenRouterError) {
        statusCode = err.statusCode >= 400 ? err.statusCode : 502;
        if (err.statusCode === 401 || err.statusCode === 403) {
          userMessage = `OpenRouter (${err.statusCode}): ${err.detail}. Periksa OPENROUTER_API_KEY di Settings > Secrets.`;
        } else if (err.statusCode === 429 || err.statusCode === 402) {
          userMessage = `OpenRouter mencapai batas kuota/rate limit (${err.statusCode}): ${err.detail}`;
        } else {
          userMessage = `OpenRouter Decisions (${err.statusCode}): ${err.detail}`;
        }
      } else if (msg.includes('API_KEY_INVALID') || /api key not valid/i.test(msg)) {
        statusCode = 400;
        userMessage =
          'API key Gemini tidak valid. Silakan periksa GEMINI_API_KEY di panel Settings > Secrets.';
      } else if (/\b400\b/.test(msg)) {
        statusCode = 400;
        userMessage = `Permintaan analisa AI ditolak (400): ${msg}`;
      } else if (msg.includes('PERMISSION_DENIED') || /\b403\b/.test(msg)) {
        statusCode = 403;
        userMessage =
          'Akses API ditolak (403). Periksa izin API key Gemini Anda di Settings > Secrets.';
      } else if (msg.includes('RESOURCE_EXHAUSTED') || /\b429\b/.test(msg)) {
        const slotCount = getConfiguredGeminiKeys().length;
        statusCode = 429;
        userMessage = `Kuota/rate limit semua ${slotCount} API key Gemini tercapai (429). Tambahkan AIRFORCE_API_KEY, OPENROUTER_API_KEY, atau slot GEMINI_API_KEY_2 di Settings > Secrets untuk rotasi otomatis.`;
      } else if (msg.includes('UNAVAILABLE') || /\b(503|502|504)\b/.test(msg)) {
        statusCode = 503;
        userMessage =
          'Server AI sedang padat sementara (503). Silakan klik Analisa Chart beberapa detik lagi.';
      } else if (msg.includes('NOT_FOUND') || /\b404\b/.test(msg)) {
        statusCode = 404;
        userMessage = 'Endpoint model AI tidak ditemukan (404).';
      } else if (err instanceof SyntaxError) {
        statusCode = 502;
        userMessage = `Respon AI tidak berbentuk JSON valid: ${msg}`;
      }

      if (useStreamKeepAlive) {
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: userMessage, statusCode }));
        }
      } else {
        res.status(statusCode).json({ error: userMessage });
      }
    } finally {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    }
  });

  // Ensure Express body-parser / middleware errors always return JSON instead of HTML
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (!req.path.startsWith('/api/')) {
        next(err);
        return;
      }
      const status =
        typeof (err as { status?: number })?.status === 'number'
          ? (err as { status: number }).status
          : 500;
      const message = err instanceof Error ? err.message : 'Terjadi kesalahan internal server.';
      res.status(status).json({ error: message });
    }
  );

  // Never let unmatched /api/* routes fall through to Vite SPA HTML fallback
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Endpoint API tidak ditemukan.' });
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
          } else if (filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      })
    );
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`AurumEA XAU/USD M5 Server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
