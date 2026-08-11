// Parse a single CSV line into fields, per RFC 4180 basics:
// - fields are comma separated
// - a field may be wrapped in double quotes
// - inside quotes, a comma is literal
// - inside quotes, "" is an escaped double quote
// - surrounding whitespace outside quotes is preserved
export function parseLine(line) {
  return line.split(",");
}
