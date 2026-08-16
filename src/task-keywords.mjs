const clean = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

export function keywordAlternatives(value, limit = 12) {
  return [...new Set(String(value ?? "")
    .split(/[\n,，]+|\s+\bOR\b\s+/i)
    .map(clean)
    .filter(Boolean))]
    .slice(0, limit);
}

export function normalizeKeywordAlternatives(value) {
  return keywordAlternatives(value).join(", ");
}

export function primarySearchKeyword(value) {
  return keywordAlternatives(value)[0] ?? "";
}
