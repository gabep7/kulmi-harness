import assert from "node:assert/strict";
import { truncateToWidth } from "./truncate.mjs";

// Plain ASCII.
assert.equal(truncateToWidth("hello", 10), "hello", "short text is unchanged");
assert.equal(truncateToWidth("hello", 5), "hello", "exactly at the limit is unchanged");
assert.equal(truncateToWidth("hello world", 8), "hello w…", "ellipsis counts toward the width");

// Astral characters are single units and must never be split into halves.
const rocket = "🚀🚀🚀🚀";
const cut = truncateToWidth(rocket, 5);
assert.ok(!hasLoneSurrogate(cut), `must not leave a lone surrogate: ${JSON.stringify(cut)}`);
assert.ok([...cut].every((ch) => ch === "🚀" || ch === "…"), `unexpected characters in ${JSON.stringify(cut)}`);

// Combining marks stay attached to their base character: a mark must never be
// the first thing in the output, and must never be separated from its base.
const combining = "cafe\u0301teria";
const combined = truncateToWidth(combining, 5);
assert.ok(!/^\u0301/.test(combined), `must not start with a bare combining mark: ${JSON.stringify(combined)}`);
assert.ok(
  !combined.includes("\u0301") || /e\u0301/.test(combined),
  `combining mark must stay attached to its base: ${JSON.stringify(combined)}`,
);

// Wide characters count as two columns.
assert.equal(truncateToWidth("日本語", 6), "日本語", "three wide chars fit in six columns");
const wide = truncateToWidth("日本語テキスト", 6);
assert.ok(displayWidth(wide) <= 6, `width ${displayWidth(wide)} exceeded 6 for ${JSON.stringify(wide)}`);
assert.ok(wide.endsWith("…"), "truncated wide text needs an ellipsis");

// A ZWJ emoji family is one unit and must not be broken apart.
const family = "👨‍👩‍👧‍👦 家族";
const familyCut = truncateToWidth(family, 4);
assert.ok(!familyCut.includes("\u200D…"), "must not cut inside a ZWJ sequence");
assert.ok(!/\u200D$/.test(familyCut.replace("…", "")), "must not end on a zero-width joiner");

// Width accounting must never exceed the limit.
for (const limit of [2, 3, 4, 7, 9]) {
  for (const sample of ["hello world", rocket, "日本語テキスト", family, combining]) {
    const out = truncateToWidth(sample, limit);
    assert.ok(displayWidth(out) <= limit, `width ${displayWidth(out)} > ${limit} for ${JSON.stringify(out)}`);
  }
}

console.log("ok");

function hasLoneSurrogate(text) {
  // A well-formed string has no unpaired surrogate code unit.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function displayWidth(text) {
  // A ZWJ sequence renders as a single glyph, so measure per grapheme cluster
  // rather than per code point: joined runs count once, as two columns.
  let width = 0;
  const chars = [...text];
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    const code = ch.codePointAt(0);
    if (code === 0x200d) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    // Skip the remainder of a ZWJ-joined run: it is part of this glyph.
    if (chars[index + 1] && chars[index + 1].codePointAt(0) === 0x200d) {
      width += 2;
      while (chars[index + 1] && chars[index + 1].codePointAt(0) === 0x200d) index += 2;
      continue;
    }
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}
