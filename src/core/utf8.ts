const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeUtf8Slice(
  bytes: Uint8Array,
  start = 0,
  end = bytes.byteLength,
): string {
  let from = Math.max(0, Math.min(bytes.byteLength, Math.trunc(start)));
  let to = Math.max(from, Math.min(bytes.byteLength, Math.trunc(end)));

  while (from < to && (((bytes[from] ?? 0) & 0xc0) === 0x80)) from += 1;
  while (to >= from) {
    try {
      return fatalUtf8Decoder.decode(bytes.subarray(from, to));
    } catch {
      to -= 1;
    }
  }
  return "";
}

export function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  return decodeUtf8Slice(bytes, 0, maximumBytes);
}

export function utf8Suffix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  return decodeUtf8Slice(bytes, bytes.byteLength - maximumBytes, bytes.byteLength);
}

export function truncateUtf8(value: string, maximumBytes: number, suffix = "…"): string {
  if (maximumBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maximumBytes) return utf8Prefix(suffix, maximumBytes);
  return `${utf8Prefix(value, maximumBytes - suffixBytes)}${suffix}`;
}

