// All money is handled in integer cents to avoid float drift.
export function toCents(amount) {
  return Math.round(amount * 100);
}

export function fromCents(cents) {
  return cents / 100;
}

export function applyRate(cents, rate) {
  return Math.round(cents * rate);
}
