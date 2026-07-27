import { truncateUtf8 } from "./utf8.js";

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
  const segments: DiffSegment[] = [
    { lines: previous, start: contextStart, end: prefix, label: " " },
    { lines: previous, start: prefix, end: previous.length - suffix, label: "-" },
    { lines: next, start: prefix, end: next.length - suffix, label: "+" },
    { lines: next, start: next.length - suffix, end: nextEnd, label: " " },
  ];
  const excerpt = materializeDiffExcerpt(segments, Math.max(1, maxLines - 3));
  const range = `@@ -${contextStart + 1},${previousEnd - contextStart} +${contextStart + 1},${nextEnd - contextStart} @@${excerpt.truncated ? " [diff excerpt]" : ""}`;
  return {
    text: [`--- a/${path}`, `+++ b/${path}`, range, ...excerpt.lines].join("\n"),
    additions,
    deletions,
    truncated: excerpt.truncated,
  };
}

export function combineDiffs(diffs: readonly string[], maxLines = 180): string | undefined {
  if (diffs.length === 0) return undefined;
  return limitLines(diffs.join("\n\n").split("\n"), maxLines).lines.join("\n");
}

interface DiffSegment {
  lines: string[];
  start: number;
  end: number;
  label: " " | "+" | "-";
}

function materializeDiffExcerpt(
  segments: readonly DiffSegment[],
  maximum: number,
): { lines: string[]; truncated: boolean } {
  const total = segments.reduce((count, segment) => count + Math.max(0, segment.end - segment.start), 0);
  const lineAt = (target: number): string => {
    let index = target;
    for (const segment of segments) {
      const length = Math.max(0, segment.end - segment.start);
      if (index < length) return `${segment.label}${clipLine(segment.lines[segment.start + index] ?? "")}`;
      index -= length;
    }
    throw new Error(`diff line index ${target} exceeds ${total}`);
  };
  if (total <= maximum) {
    return { lines: Array.from({ length: total }, (_, index) => lineAt(index)), truncated: false };
  }
  const head = Math.ceil((maximum - 1) / 2);
  const tail = Math.max(0, maximum - head - 1);
  return {
    lines: [
      ...Array.from({ length: head }, (_, index) => lineAt(index)),
      `... ${total - head - tail} lines omitted from diff excerpt ...`,
      ...Array.from({ length: tail }, (_, index) => lineAt(total - tail + index)),
    ],
    truncated: true,
  };
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function clipLine(line: string): string {
  return truncateUtf8(line, 400);
}

function limitLines(lines: string[], maximum: number): { lines: string[]; truncated: boolean } {
  if (lines.length <= maximum) return { lines, truncated: false };
  const head = Math.ceil((maximum - 1) / 2);
  const tail = Math.max(0, maximum - head - 1);
  return {
    lines: [
      ...lines.slice(0, head),
      `... ${lines.length - head - tail} lines omitted from diff excerpt ...`,
      ...lines.slice(lines.length - tail),
    ],
    truncated: true,
  };
}
