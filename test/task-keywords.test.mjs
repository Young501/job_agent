import test from "node:test";
import assert from "node:assert/strict";

import {
  keywordAlternatives,
  normalizeKeywordAlternatives,
  primarySearchKeyword
} from "../src/task-keywords.mjs";

test("keyword alternatives accept commas, newlines, and legacy OR syntax", () => {
  assert.deepEqual(keywordAlternatives("intern OR internship"), ["intern", "internship"]);
  assert.deepEqual(keywordAlternatives("intern, internship\ngraduate"), ["intern", "internship", "graduate"]);
});

test("task keywords use a canonical display value and first platform search term", () => {
  assert.equal(normalizeKeywordAlternatives(" intern OR internship "), "intern, internship");
  assert.equal(primarySearchKeyword("intern, internship"), "intern");
});

test("a normal multi-word search phrase remains intact", () => {
  assert.deepEqual(keywordAlternatives("graduate software engineer"), ["graduate software engineer"]);
  assert.equal(primarySearchKeyword("graduate software engineer"), "graduate software engineer");
});
