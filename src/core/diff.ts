export interface TextDiff {
  text: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export function createTextDiff(
  path: string,
  before: string,
  after: string,
  maxLines = 120,
): TextDiff | undefined {
  if (before === after) return undefined;

  const previous = splitLines(before);
  const next = splitLines(after);
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const deletions = previous.length - prefix - suffix;
  const additions = next.length - prefix - suffix;
  const contextStart = Math.max(0, prefix - 3);
  const previousEnd = Math.min(previous.length, previous.length - suffix + 3);
  const nextEnd = Math.min(next.length, next.length - suffix + 3);
  const body = [
    ...previous.slice(contextStart, prefix).map((line) => ` ${clipLine(line)}`),
    ...previous.slice(prefix, previous.length - suffix).map((line) => `-${clipLine(line)}`),
    ...next.slice(prefix, next.length - suffix).map((line) => `+${clipLine(line)}`),
    ...next.slice(next.length - suffix, nextEnd).map((line) => ` ${clipLine(line)}`),
  ];
  const limited = limitLines(body, Math.max(1, maxLines - 3));
  const header = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${previousEnd - contextStart} +${contextStart + 1},${nextEnd - contextStart} @@`,
  ];
  return {
    text: [...header, ...limited.lines].join("\n"),
    additions,
    deletions,
    truncated: limited.truncated,
  };
}

export function combineDiffs(diffs: readonly string[], maxLines = 180): string | undefined {
  if (diffs.length === 0) return undefined;
  return limitLines(diffs.join("\n\n").split("\n"), maxLines).lines.join("\n");
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function clipLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  return bytes.length <= 400 ? line : `${bytes.subarray(0, 399).toString("utf8")}…`;
}

function limitLines(lines: string[], maximum: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= maximum) return { lines, truncated: false };
  const head = Math.max(1, Math.floor((maximum - 1) / 2));
  const tail = Math.max(0, maximum - head - 1);
  return {
    lines: [
      ...lines.slice(0, head),
      `... ${lines.length - head - tail} diff lines omitted ...`,
      ...lines.slice(lines.length - tail),
    ],
    truncated: true,
  };
}
