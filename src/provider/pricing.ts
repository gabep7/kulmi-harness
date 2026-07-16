export interface PricingRates {
  inputCacheHit: number; // USD per 1M tokens
  inputCacheMiss: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
}

const FALLBACK_RATES: PricingRates = {
  inputCacheHit: 0,
  inputCacheMiss: 0,
  output: 0,
};

const MODEL_PRICING: Record<string, PricingRates> = {};

export function registerPricing(model: string, rates: PricingRates): void {
  MODEL_PRICING[model] = rates;
}

export function estimateCost(
  model: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  },
): number {
  const rates = MODEL_PRICING[model] ?? FALLBACK_RATES;
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