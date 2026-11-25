import type {
  Candle,
  ChartStructureAnalysis,
  IndicatorSnapshot,
  SupportResistanceLevel,
} from '../types/trading.ts';

export function computeEmaArray(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let prevEma = sum / period;
  result[period - 1] = Number(prevEma.toFixed(2));

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prevEma = values[i] * k + prevEma * (1 - k);
    result[i] = Number(prevEma.toFixed(2));
  }
  return result;
}

export function computeRsi14(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

export function computeMacd(closes: number[]): {
  line: number | null;
  signal: number | null;
  histogram: number | null;
} {
  if (closes.length < 35) {
    return { line: null, signal: null, histogram: null };
  }

  const ema12 = computeEmaArray(closes, 12);
  const ema26 = computeEmaArray(closes, 26);

  const macdValues: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const fast = ema12[i];
    const slow = ema26[i];
    if (fast !== null && slow !== null) {
      macdValues.push(fast - slow);
    }
  }

  if (macdValues.length < 9) {
    return { line: null, signal: null, histogram: null };
  }

  const signalArr = computeEmaArray(macdValues, 9);
  const lastMacd = macdValues[macdValues.length - 1];
  const lastSignal = signalArr[signalArr.length - 1];

  if (lastSignal === null) {
    return { line: Number(lastMacd.toFixed(3)), signal: null, histogram: null };
  }

  return {
    line: Number(lastMacd.toFixed(3)),
    signal: Number(lastSignal.toFixed(3)),
    histogram: Number((lastMacd - lastSignal).toFixed(3)),
  };
}

export function computeAtr14(candles: Candle[], period = 14): number | null {
  if (candles.length <= period) return null;

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }

  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trs[i];
  }
  atr /= period;

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return Number(atr.toFixed(2));
}

export function computeBollingerSeries(
  candles: Candle[],
  period = 20,
  mult = 2
): {
  upperSeries: Array<{ time: number; value: number }>;
  lowerSeries: Array<{ time: number; value: number }>;
  latest: { upper: number | null; middle: number | null; lower: number | null };
} {
  const upperSeries: Array<{ time: number; value: number }> = [];
  const lowerSeries: Array<{ time: number; value: number }> = [];
  let latest: { upper: number | null; middle: number | null; lower: number | null } = {
    upper: null,
    middle: null,
    lower: null,
  };

  if (candles.length < period) {
    return { upperSeries, lowerSeries, latest };
  }

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close;
    }
    const mean = sum / period;

    let sqDiffSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = candles[j].close - mean;
      sqDiffSum += diff * diff;
    }
    const stdDev = Math.sqrt(sqDiffSum / period);

    const upper = Number((mean + mult * stdDev).toFixed(2));
    const lower = Number((mean - mult * stdDev).toFixed(2));
    const middle = Number(mean.toFixed(2));

    upperSeries.push({ time: candles[i].time, value: upper });
    lowerSeries.push({ time: candles[i].time, value: lower });
    if (i === candles.length - 1) {
      latest = { upper, middle, lower };
    }
  }

  return { upperSeries, lowerSeries, latest };
}

export function analyzeChartStructure(
  candles: Candle[],
  atr: number | null
): ChartStructureAnalysis {
  if (candles.length < 10) {
    const last = candles[candles.length - 1];
    const high = last?.high ?? 0;
    const low = last?.low ?? 0;
    return {
      marketStructure: 'CONSOLIDATION',
      structureSummary: 'Data candle belum cukup untuk pemetaan struktur S/R penuh.',
      nearestResistance: null,
      nearestSupport: null,
      resistances: [],
      supports: [],
      pivotPoint: last ? Number(((high + low + last.close) / 3).toFixed(2)) : null,
      sessionHigh: Number(high.toFixed(2)),
      sessionLow: Number(low.toFixed(2)),
      roundLevels: [],
      candlestickPatterns: [],
      chartPatterns: [],
      fvgZones: [],
      pricePositionNote: 'Menunggu akumulasi candle.',
    };
  }

  const n = candles.length;
  const currentPrice = candles[n - 1].close;
  const safeAtr = Math.max(0.5, atr ?? 2.5);
  const clusterTol = Math.max(0.65, safeAtr * 0.45);

  interface RawPivot {
    idx: number;
    price: number;
    kind: 'HIGH' | 'LOW';
    weight: number;
  }

  const swingHighs: RawPivot[] = [];
  const swingLows: RawPivot[] = [];

  // Detect fractal swing highs & lows (radius 3 = intraday, radius 6 = major)
  for (let i = 3; i < n - 2; i++) {
    const c = candles[i];
    let isHigh3 = true;
    let isLow3 = true;
    for (let k = i - 3; k <= i + 2; k++) {
      if (k === i || k < 0 || k >= n) continue;
      if (candles[k].high > c.high) isHigh3 = false;
      if (candles[k].low < c.low) isLow3 = false;
    }

    let isHigh6 = false;
    let isLow6 = false;
    if (i >= 6 && i < n - 4) {
      isHigh6 = isHigh3;
      isLow6 = isLow3;
      for (let k = i - 6; k <= i + 4; k++) {
        if (k === i || k < 0 || k >= n) continue;
        if (candles[k].high > c.high) isHigh6 = false;
        if (candles[k].low < c.low) isLow6 = false;
      }
    }

    if (isHigh3) {
      swingHighs.push({ idx: i, price: c.high, kind: 'HIGH', weight: isHigh6 ? 2 : 1 });
    }
    if (isLow3) {
      swingLows.push({ idx: i, price: c.low, kind: 'LOW', weight: isLow6 ? 2 : 1 });
    }
  }

  const sessionSlice = candles.slice(-96);
  const sessionHigh = Number(Math.max(...sessionSlice.map((c) => c.high)).toFixed(2));
  const sessionLow = Number(Math.min(...sessionSlice.map((c) => c.low)).toFixed(2));
  const pivotPoint = Number(((sessionHigh + sessionLow + currentPrice) / 3).toFixed(2));

  // Add session extreme & prior major swings as anchor pivots
  const allPivots: RawPivot[] = [
    ...swingHighs,
    ...swingLows,
    { idx: n - 1, price: sessionHigh, kind: 'HIGH', weight: 2 },
    { idx: n - 1, price: sessionLow, kind: 'LOW', weight: 2 },
  ];

  interface SrCluster {
    weightedSum: number;
    weightTotal: number;
    touches: number;
    lastIdx: number;
  }

  const clusters: SrCluster[] = [];
  for (const p of allPivots) {
    let matched: SrCluster | null = null;
    let bestDiff = Infinity;
    for (const cl of clusters) {
      const center = cl.weightedSum / cl.weightTotal;
      const diff = Math.abs(center - p.price);
      if (diff <= clusterTol && diff < bestDiff) {
        bestDiff = diff;
        matched = cl;
      }
    }
    if (matched) {
      matched.weightedSum += p.price * p.weight;
      matched.weightTotal += p.weight;
      matched.touches += 1;
      matched.lastIdx = Math.max(matched.lastIdx, p.idx);
    } else {
      clusters.push({
        weightedSum: p.price * p.weight,
        weightTotal: p.weight,
        touches: p.weight,
        lastIdx: p.idx,
      });
    }
  }

  // Count additional historical wick/close rejections near each cluster center
  const wickTol = Math.max(0.35, safeAtr * 0.22);
  const scoredLevels = clusters.map((cl) => {
    const price = Number((cl.weightedSum / cl.weightTotal).toFixed(2));
    let reactionTouches = 0;
    for (let i = Math.max(0, n - 140); i < n - 1; i++) {
      const c = candles[i];
      const nearHigh = Math.abs(c.high - price) <= wickTol && c.close < price;
      const nearLow = Math.abs(c.low - price) <= wickTol && c.close > price;
      if (nearHigh || nearLow) reactionTouches += 1;
    }
    const touches = Math.max(cl.touches, Math.min(8, Math.round((cl.touches + reactionTouches) / 2)));
    const strength: SupportResistanceLevel['strength'] =
      touches >= 3 || cl.weightTotal >= 4
        ? 'STRONG'
        : touches >= 2 || cl.weightTotal >= 2
        ? 'MODERATE'
        : 'MINOR';
    return { price, touches, strength };
  });

  const minGapFromPrice = Math.max(0.15, safeAtr * 0.08);
  const rawResistances = scoredLevels
    .filter((l) => l.price > currentPrice + minGapFromPrice)
    .sort((a, b) => a.price - b.price);
  const rawSupports = scoredLevels
    .filter((l) => l.price < currentPrice - minGapFromPrice)
    .sort((a, b) => b.price - a.price);

  const dedupLevels = (arr: typeof rawResistances, minSpacing: number) => {
    const out: typeof rawResistances = [];
    for (const item of arr) {
      if (out.every((kept) => Math.abs(kept.price - item.price) >= minSpacing)) {
        out.push(item);
      }
      if (out.length >= 3) break;
    }
    return out;
  };

  const minSpacing = Math.max(0.8, safeAtr * 0.55);
  const resistances: SupportResistanceLevel[] = dedupLevels(rawResistances, minSpacing).map((l, idx) => {
    const dist = Number((l.price - currentPrice).toFixed(2));
    const distAtr = Number((dist / safeAtr).toFixed(2));
    return {
      price: l.price,
      type: 'RESISTANCE',
      strength: l.strength,
      touches: l.touches,
      distanceUsd: dist,
      distanceAtr: distAtr,
      label: `R${idx + 1} (${l.strength === 'STRONG' ? 'Kuat' : l.strength === 'MODERATE' ? 'Sedang' : 'Minor'} · ${l.touches}x)`,
    };
  });

  const supports: SupportResistanceLevel[] = dedupLevels(rawSupports, minSpacing).map((l, idx) => {
    const dist = Number((currentPrice - l.price).toFixed(2));
    const distAtr = Number((dist / safeAtr).toFixed(2));
    return {
      price: l.price,
      type: 'SUPPORT',
      strength: l.strength,
      touches: l.touches,
      distanceUsd: dist,
      distanceAtr: distAtr,
      label: `S${idx + 1} (${l.strength === 'STRONG' ? 'Kuat' : l.strength === 'MODERATE' ? 'Sedang' : 'Minor'} · ${l.touches}x)`,
    };
  });

  const nearestResistance = resistances[0] ?? null;
  const nearestSupport = supports[0] ?? null;

  // Market Structure (HH/HL vs LH/LL vs BOS/CHoCH)
  let marketStructure: ChartStructureAnalysis['marketStructure'] = 'CONSOLIDATION';
  let structureSummary = 'Konsolidasi / pergerakan menyamping di antara level S/R.';

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const shPrev = swingHighs[swingHighs.length - 2];
    const shLast = swingHighs[swingHighs.length - 1];
    const slPrev = swingLows[swingLows.length - 2];
    const slLast = swingLows[swingLows.length - 1];

    const hh = shLast.price > shPrev.price + 0.2;
    const lh = shLast.price < shPrev.price - 0.2;
    const hl = slLast.price > slPrev.price + 0.2;
    const ll = slLast.price < slPrev.price - 0.2;

    if (hh && hl) {
      if (currentPrice < slLast.price) {
        marketStructure = 'TRANSITION_BOS';
        structureSummary = `Transisi Bearish CHoCH: sempat HH (${shLast.price.toFixed(2)}) & HL (${slLast.price.toFixed(2)}), namun harga menembus ke bawah HL terakhir.`;
      } else {
        marketStructure = 'UPTREND_HH_HL';
        structureSummary = `Uptrend Struktur Sehat (HH ${shPrev.price.toFixed(2)}→${shLast.price.toFixed(2)} & HL ${slPrev.price.toFixed(2)}→${slLast.price.toFixed(2)}).`;
      }
    } else if (lh && ll) {
      if (currentPrice > shLast.price) {
        marketStructure = 'TRANSITION_BOS';
        structureSummary = `Transisi Bullish CHoCH: sempat LH (${shLast.price.toFixed(2)}) & LL (${slLast.price.toFixed(2)}), namun harga break di atas LH terakhir.`;
      } else {
        marketStructure = 'DOWNTREND_LH_LL';
        structureSummary = `Downtrend Struktur Sehat (LH ${shPrev.price.toFixed(2)}→${shLast.price.toFixed(2)} & LL ${slPrev.price.toFixed(2)}→${slLast.price.toFixed(2)}).`;
      }
    } else if (currentPrice > shLast.price + 0.25) {
      marketStructure = 'TRANSITION_BOS';
      structureSummary = `Bullish Breakout / BOS ke atas Swing High ${shLast.price.toFixed(2)}.`;
    } else if (currentPrice < slLast.price - 0.25) {
      marketStructure = 'TRANSITION_BOS';
      structureSummary = `Bearish Breakdown / BOS ke bawah Swing Low ${slLast.price.toFixed(2)}.`;
    } else {
      marketStructure = 'CONSOLIDATION';
      structureSummary = `Konsolidasi Range antara Swing Low ${slLast.price.toFixed(2)} dan Swing High ${shLast.price.toFixed(2)}.`;
    }
  }

  // Candlestick Patterns (evaluate last closed & active bars)
  const candlestickPatterns: string[] = [];
  const barCur = candles[n - 1];
  const barPrev = candles[n - 2];
  const barPrev2 = candles[n - 3];

  const inspectCandle = (c: Candle, tag: string) => {
    const range = Math.max(0.05, c.high - c.low);
    const body = Math.abs(c.close - c.open);
    const upWick = c.high - Math.max(c.open, c.close);
    const dnWick = Math.min(c.open, c.close) - c.low;
    const isBull = c.close >= c.open;

    if (dnWick >= Math.max(body * 2.1, range * 0.55) && upWick <= range * 0.22) {
      const nearSup = nearestSupport && Math.abs(c.low - nearestSupport.price) <= safeAtr * 0.6;
      candlestickPatterns.push(
        `Bullish Pin Bar / Hammer (${tag})${nearSup ? ` di dekat ${nearestSupport.label}` : ''}`
      );
    } else if (upWick >= Math.max(body * 2.1, range * 0.55) && dnWick <= range * 0.22) {
      const nearRes = nearestResistance && Math.abs(c.high - nearestResistance.price) <= safeAtr * 0.6;
      candlestickPatterns.push(
        `Bearish Pin Bar / Shooting Star (${tag})${nearRes ? ` di dekat ${nearestResistance.label}` : ''}`
      );
    } else if (body / range >= 0.72 && range >= safeAtr * 0.85) {
      candlestickPatterns.push(
        `${isBull ? 'Bullish' : 'Bearish'} Momentum Marubozu (${tag}, body ${body.toFixed(2)} USD)`
      );
    } else if (body / range <= 0.16 && range >= safeAtr * 0.45) {
      candlestickPatterns.push(`Doji / Keraguan Pasar (${tag})`);
    }
  };

  inspectCandle(barPrev, 'candle tutup terakhir');
  if (barCur.high - barCur.low >= safeAtr * 0.5) {
    inspectCandle(barCur, 'candle berjalan');
  }

  // Engulfing & Inside Bar on last closed pair
  const prev2Bull = barPrev2.close >= barPrev2.open;
  const prevBull = barPrev.close >= barPrev.open;
  const prev2Body = Math.abs(barPrev2.close - barPrev2.open);
  const prevBody = Math.abs(barPrev.close - barPrev.open);

  if (!prev2Bull && prevBull && prevBody > prev2Body * 1.15 && barPrev.close >= barPrev2.open && barPrev.open <= barPrev2.close) {
    candlestickPatterns.push('Bullish Engulfing');
  } else if (prev2Bull && !prevBull && prevBody > prev2Body * 1.15 && barPrev.close <= barPrev2.open && barPrev.open >= barPrev2.close) {
    candlestickPatterns.push('Bearish Engulfing');
  }
  if (barPrev.high <= barPrev2.high && barPrev.low >= barPrev2.low) {
    candlestickPatterns.push('Inside Bar (Kompresi sebelum ekspansi)');
  }

  // Macro Chart Patterns (Double Top/Bottom, Triangles, Wedges, Liquidity Sweep, Breakout)
  const chartPatterns: string[] = [];

  if (swingHighs.length >= 2) {
    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];
    if (h2.idx - h1.idx >= 5 && Math.abs(h1.price - h2.price) <= safeAtr * 0.45) {
      chartPatterns.push(
        `Double Top / Equal Highs Liquidity Pool sekitar ${((h1.price + h2.price) / 2).toFixed(2)}`
      );
    }
  }
  if (swingLows.length >= 2) {
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];
    if (l2.idx - l1.idx >= 5 && Math.abs(l1.price - l2.price) <= safeAtr * 0.45) {
      chartPatterns.push(
        `Double Bottom / Equal Lows Liquidity Pool sekitar ${((l1.price + l2.price) / 2).toFixed(2)}`
      );
    }
  }

  // Triangle / Wedge / Channel geometry using recent 32 bars split into two halves
  if (n >= 32) {
    const seg1 = candles.slice(-32, -16);
    const seg2 = candles.slice(-16);
    const max1 = Math.max(...seg1.map((c) => c.high));
    const max2 = Math.max(...seg2.map((c) => c.high));
    const min1 = Math.min(...seg1.map((c) => c.low));
    const min2 = Math.min(...seg2.map((c) => c.low));
    const highDelta = max2 - max1;
    const lowDelta = min2 - min1;
    const flatTol = safeAtr * 0.35;

    if (Math.abs(highDelta) <= flatTol && lowDelta > flatTol * 1.2) {
      chartPatterns.push(`Ascending Triangle (Resistance datar ~${max2.toFixed(2)}, Low meninggi)`);
    } else if (Math.abs(lowDelta) <= flatTol && highDelta < -flatTol * 1.2) {
      chartPatterns.push(`Descending Triangle (Support datar ~${min2.toFixed(2)}, High menurun)`);
    } else if (highDelta < -flatTol && lowDelta > flatTol) {
      chartPatterns.push('Symmetrical Triangle (Kompresi harga mengerucut siap breakout)');
    } else if (highDelta > flatTol && lowDelta > highDelta * 1.25) {
      chartPatterns.push('Rising Wedge (Potensi kehabisan dorongan beli jika break bawah)');
    } else if (lowDelta < -flatTol && highDelta < lowDelta * 1.25) {
      chartPatterns.push('Falling Wedge (Potensi reversal naik jika break atas)');
    }
  }

  // Liquidity Sweep detection on last 2 candles against prior swing high/low
  if (swingHighs.length >= 1) {
    const refHigh = swingHighs[swingHighs.length - 1];
    if (n - 1 - refHigh.idx >= 3 && (barPrev.high > refHigh.price || barCur.high > refHigh.price) && currentPrice < refHigh.price) {
      chartPatterns.push(`Bearish Liquidity Sweep di atas ${refHigh.price.toFixed(2)} (Fake Breakout)`);
    } else if (n - 1 - refHigh.idx >= 3 && barPrev.close > refHigh.price && currentPrice > refHigh.price) {
      chartPatterns.push(`Bullish Breakout terkonfirmasi di atas ${refHigh.price.toFixed(2)}`);
    }
  }
  if (swingLows.length >= 1) {
    const refLow = swingLows[swingLows.length - 1];
    if (n - 1 - refLow.idx >= 3 && (barPrev.low < refLow.price || barCur.low < refLow.price) && currentPrice > refLow.price) {
      chartPatterns.push(`Bullish Liquidity Sweep di bawah ${refLow.price.toFixed(2)} (Stop Hunt Rejection)`);
    } else if (n - 1 - refLow.idx >= 3 && barPrev.close < refLow.price && currentPrice < refLow.price) {
      chartPatterns.push(`Bearish Breakdown terkonfirmasi di bawah ${refLow.price.toFixed(2)}`);
    }
  }

  // Fair Value Gaps (FVG / Imbalance) in last 25 candles
  const fvgZones: ChartStructureAnalysis['fvgZones'] = [];
  const startFvg = Math.max(2, n - 25);
  for (let i = startFvg; i < n; i++) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c0.high < c2.low - 0.15 && currentPrice >= c0.high) {
      fvgZones.push({
        type: 'BULLISH_FVG',
        low: Number(c0.high.toFixed(2)),
        high: Number(c2.low.toFixed(2)),
      });
    } else if (c0.low > c2.high + 0.15 && currentPrice <= c0.low) {
      fvgZones.push({
        type: 'BEARISH_FVG',
        low: Number(c2.high.toFixed(2)),
        high: Number(c0.low.toFixed(2)),
      });
    }
  }

  // Nearest Psychological Round Levels ($10 increments on XAU/USD)
  const baseTen = Math.floor(currentPrice / 10) * 10;
  const roundLevels = [baseTen - 10, baseTen, baseTen + 10, baseTen + 20]
    .filter((lvl) => lvl > 0)
    .sort((a, b) => Math.abs(a - currentPrice) - Math.abs(b - currentPrice))
    .slice(0, 3);

  const resNote = nearestResistance
    ? `R1=${nearestResistance.price.toFixed(2)} (+${nearestResistance.distanceUsd.toFixed(2)} USD / ${nearestResistance.distanceAtr} ATR${nearestResistance.distanceAtr <= 0.35 ? ' · SANGAT DEKAT ATAP' : ''})`
    : 'Tidak ada R terdekat';
  const supNote = nearestSupport
    ? `S1=${nearestSupport.price.toFixed(2)} (-${nearestSupport.distanceUsd.toFixed(2)} USD / ${nearestSupport.distanceAtr} ATR${nearestSupport.distanceAtr <= 0.35 ? ' · SANGAT DEKAT LANTAI' : ''})`
    : 'Tidak ada S terdekat';
  const pricePositionNote = `${resNote} | ${supNote}`;

  return {
    marketStructure,
    structureSummary,
    nearestResistance,
    nearestSupport,
    resistances,
    supports,
    pivotPoint,
    sessionHigh,
    sessionLow,
    roundLevels,
    candlestickPatterns: candlestickPatterns.slice(0, 4),
    chartPatterns: chartPatterns.slice(0, 4),
    fvgZones: fvgZones.slice(-3),
    pricePositionNote,
  };
}

export function computeStochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3
): { k: number | null; d: number | null } {
  if (candles.length < kPeriod + dPeriod) return { k: null, d: null };
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }
    const range = highest - lowest;
    const rawK = range > 0 ? ((candles[i].close - lowest) / range) * 100 : 50;
    kValues.push(rawK);
  }
  const latestK = kValues[kValues.length - 1];
  const dSlice = kValues.slice(-dPeriod);
  const latestD = dSlice.reduce((a, b) => a + b, 0) / dSlice.length;
  return {
    k: Number(latestK.toFixed(1)),
    d: Number(latestD.toFixed(1)),
  };
}

export function computeAdx14(candles: Candle[], period = 14): number | null {
  if (candles.length < period * 2 + 2) return null;
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      )
    );
  }

  let smoothTr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  for (let i = 0; i < period; i++) {
    smoothTr += tr[i];
    smoothPlus += plusDm[i];
    smoothMinus += minusDm[i];
  }

  const dxArr: number[] = [];
  for (let i = period; i < tr.length; i++) {
    smoothTr = smoothTr - smoothTr / period + tr[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[i];

    const plusDi = smoothTr > 0 ? (smoothPlus / smoothTr) * 100 : 0;
    const minusDi = smoothTr > 0 ? (smoothMinus / smoothTr) * 100 : 0;
    const diSum = plusDi + minusDi;
    dxArr.push(diSum > 0 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0);
  }

  if (dxArr.length < period) return null;
  let adx = 0;
  for (let i = 0; i < period; i++) {
    adx += dxArr[i];
  }
  adx /= period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }
  return Number(adx.toFixed(1));
}

export function computeObvTrend(
  candles: Candle[],
  lookback = 20
): 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL' {
  if (candles.length < lookback + 2) return 'NEUTRAL';
  let obv = 0;
  const obvSeries: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = Math.max(1, candles[i].volume || 1);
    if (candles[i].close > candles[i - 1].close) obv += vol;
    else if (candles[i].close < candles[i - 1].close) obv -= vol;
    obvSeries.push(obv);
  }
  const recent = obvSeries.slice(-lookback);
  const firstHalf = recent.slice(0, Math.floor(lookback / 2));
  const secondHalf = recent.slice(Math.floor(lookback / 2));
  const avg1 = firstHalf.reduce((a, b) => a + b, 0) / Math.max(1, firstHalf.length);
  const avg2 = secondHalf.reduce((a, b) => a + b, 0) / Math.max(1, secondHalf.length);
  const diff = avg2 - avg1;
  const avgVol =
    candles.slice(-lookback).reduce((a, c) => a + Math.max(1, c.volume || 1), 0) / lookback;
  if (diff > avgVol * 1.1) return 'ACCUMULATION';
  if (diff < -avgVol * 1.1) return 'DISTRIBUTION';
  return 'NEUTRAL';
}

export function computeFibonacciLevels(candles: Candle[]): IndicatorSnapshot['fibonacci'] {
  const slice = candles.slice(-60);
  if (slice.length < 10) return undefined;
  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i].high > slice[highIdx].high) highIdx = i;
    if (slice[i].low < slice[lowIdx].low) lowIdx = i;
  }
  const swingHigh = Number(slice[highIdx].high.toFixed(2));
  const swingLow = Number(slice[lowIdx].low.toFixed(2));
  const range = Math.max(0.5, swingHigh - swingLow);
  const trend: 'UP' | 'DOWN' = highIdx > lowIdx ? 'UP' : 'DOWN';

  if (trend === 'UP') {
    return {
      swingHigh,
      swingLow,
      trend,
      r382: Number((swingHigh - range * 0.382).toFixed(2)),
      r500: Number((swingHigh - range * 0.5).toFixed(2)),
      r618: Number((swingHigh - range * 0.618).toFixed(2)),
      r786: Number((swingHigh - range * 0.786).toFixed(2)),
      ext1272: Number((swingLow + range * 1.272).toFixed(2)),
      ext1618: Number((swingLow + range * 1.618).toFixed(2)),
    };
  }
  return {
    swingHigh,
    swingLow,
    trend,
    r382: Number((swingLow + range * 0.382).toFixed(2)),
    r500: Number((swingLow + range * 0.5).toFixed(2)),
    r618: Number((swingLow + range * 0.618).toFixed(2)),
    r786: Number((swingLow + range * 0.786).toFixed(2)),
    ext1272: Number((swingHigh - range * 1.272).toFixed(2)),
    ext1618: Number((swingHigh - range * 1.618).toFixed(2)),
  };
}

export function buildIndicatorPack(candles: Candle[]): {
  snapshot: IndicatorSnapshot;
  ema9Series: Array<{ time: number; value: number }>;
  ema21Series: Array<{ time: number; value: number }>;
  ema50Series: Array<{ time: number; value: number }>;
  bbUpperSeries: Array<{ time: number; value: number }>;
  bbLowerSeries: Array<{ time: number; value: number }>;
} {
  const closes = candles.map((c) => c.close);
  const ema9Arr = computeEmaArray(closes, 9);
  const ema21Arr = computeEmaArray(closes, 21);
  const ema50Arr = computeEmaArray(closes, 50);
  const ema200Arr = computeEmaArray(closes, 200);

  const ema9Series: Array<{ time: number; value: number }> = [];
  const ema21Series: Array<{ time: number; value: number }> = [];
  const ema50Series: Array<{ time: number; value: number }> = [];

  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].time;
    if (ema9Arr[i] !== null) ema9Series.push({ time: t, value: ema9Arr[i]! });
    if (ema21Arr[i] !== null) ema21Series.push({ time: t, value: ema21Arr[i]! });
    if (ema50Arr[i] !== null) ema50Series.push({ time: t, value: ema50Arr[i]! });
  }

  const bb = computeBollingerSeries(candles, 20, 2);
  const lookback = candles.slice(-30);
  const swingHigh = lookback.length > 0 ? Math.max(...lookback.map((c) => c.high)) : 0;
  const swingLow = lookback.length > 0 ? Math.min(...lookback.map((c) => c.low)) : 0;
  const atr14 = computeAtr14(candles, 14);
  const structure = analyzeChartStructure(candles, atr14);

  const lastIdx = candles.length - 1;
  const snapshot: IndicatorSnapshot = {
    ema9: lastIdx >= 0 ? ema9Arr[lastIdx] : null,
    ema21: lastIdx >= 0 ? ema21Arr[lastIdx] : null,
    ema50: lastIdx >= 0 ? ema50Arr[lastIdx] : null,
    ema200: lastIdx >= 0 ? ema200Arr[lastIdx] : null,
    rsi14: computeRsi14(closes, 14),
    stochastic: computeStochastic(candles, 14, 3),
    adx14: computeAdx14(candles, 14),
    obvTrend: computeObvTrend(candles, 20),
    fibonacci: computeFibonacciLevels(candles),
    macd: computeMacd(closes),
    atr14,
    bollinger: bb.latest,
    swingHigh: Number(swingHigh.toFixed(2)),
    swingLow: Number(swingLow.toFixed(2)),
    structure,
  };

  return {
    snapshot,
    ema9Series,
    ema21Series,
    ema50Series,
    bbUpperSeries: bb.upperSeries,
    bbLowerSeries: bb.lowerSeries,
  };
}

export function calculateXauLotSize(
  balance: number,
  riskPercent: number,
  entryPrice: number,
  stopLoss: number
): number {
  const slDistance = Math.abs(entryPrice - stopLoss);
  if (slDistance < 0.25) return 0.01;
  const riskUsd = (balance * riskPercent) / 100;
  // Standard XAUUSD: 1.00 lot = 100 oz => $100 per $1.00 price move
  const rawLots = riskUsd / (slDistance * 100);
  const clamped = Math.max(0.01, Math.min(10.0, rawLots));
  return Number(clamped.toFixed(2));
}

export function calculateXauPnl(
  side: 'BUY' | 'SELL',
  lots: number,
  entryPrice: number,
  currentPrice: number
): number {
  const diff = side === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
  return Number((diff * lots * 100).toFixed(2));
}
