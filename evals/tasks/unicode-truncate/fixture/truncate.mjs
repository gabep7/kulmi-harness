// Truncate text to at most `maxWidth` display columns, appending an ellipsis
// character when anything was removed. The ellipsis counts toward the width.
//
// Rules:
// - Never split a surrogate pair or a combining sequence.
// - East Asian wide characters occupy two columns.
// - Zero-width joiner sequences (such as emoji families) are one unit.
// - Text already within the limit is returned unchanged, with no ellipsis.
export function truncateToWidth(text, maxWidth) {
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 1)}…`;
}
