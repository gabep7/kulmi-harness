// mapLimit runs an async mapper over items with at most `limit` in flight.
// Results must be returned in input order, regardless of completion order.
// If any mapper rejects, mapLimit must reject with that first error.
export async function mapLimit(items, limit, mapper) {
  const results = [];
  for (const item of items) {
    results.push(await mapper(item));
  }
  return results;
}
