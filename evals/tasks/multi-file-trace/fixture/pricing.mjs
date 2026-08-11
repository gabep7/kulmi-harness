import { config } from "./config.mjs";
import { applyRate, toCents } from "./money.mjs";

export function subtotalCents(items) {
  return items.reduce((sum, item) => sum + toCents(item.price) * item.quantity, 0);
}

export function discountFor(subtotal) {
  let discount = 0;
  for (const tier of config.tiers) {
    if (subtotal >= tier.minSubtotal) discount = tier.discount;
  }
  return discount;
}

export function totalCents(items) {
  const subtotal = subtotalCents(items);
  const discount = discountFor(subtotal);
  const discounted = subtotal - applyRate(subtotal, discount);
  return discounted + applyRate(discounted, config.taxRate);
}
