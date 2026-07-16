export function computeTotal(items) {
  return items.reduce((total, item) => total + item, 0);
}
