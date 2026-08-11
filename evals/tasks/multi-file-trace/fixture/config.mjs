export const config = {
  currency: "EUR",
  // Discount tiers are applied to the subtotal, highest matching tier wins.
  tiers: [
    { minSubtotal: 0, discount: 0 },
    { minSubtotal: 100, discount: 0.05 },
    { minSubtotal: 500, discount: 0.1 },
  ],
  taxRate: 0.21,
};
