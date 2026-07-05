export interface PricingRates {
  inputCacheHit: number; // USD per 1M tokens
  inputCacheMiss: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
}

const MODEL_PRICING: Record<string, PricingRates> = {
  "mimo-v2.5-pro": {
    inputCacheHit: 0.0036,
    inputCacheMiss: 0.435,
    output: 0.87,
  },
  "mimo-v2.5": {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
  },
};

export function estimateCost(
  model: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  },
): number {
  const rates = MODEL_PRICING[model] ?? MODEL_PRICING["mimo-v2.5-pro"]!;
  const inputCost =
    (usage.cacheHitTokens / 1_000_000) * rates.inputCacheHit +
    (usage.cacheMissTokens / 1_000_000) * rates.inputCacheMiss;
  const outputCost = (usage.completionTokens / 1_000_000) * rates.output;
  return inputCost + outputCost;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

export { MODEL_PRICING };
