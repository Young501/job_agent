const clean = (value) => String(value ?? "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const companyName = (value) => clean(value)
  .replace(/\b(?:pty|proprietary|limited|ltd|incorporated|inc|corporation|corp|llc)\b/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const locationAliases = [
  ["act", /\b(?:canberra|australian capital territory|act)\b/],
  ["nsw", /\b(?:sydney|new south wales|nsw)\b/],
  ["vic", /\b(?:melbourne|victoria|vic)\b/],
  ["qld", /\b(?:brisbane|queensland|qld)\b/],
  ["wa", /\b(?:perth|western australia|wa)\b/],
  ["sa", /\b(?:adelaide|south australia|sa)\b/],
  ["tas", /\b(?:hobart|launceston|tasmania|tas)\b/],
  ["nt", /\b(?:darwin|northern territory|nt)\b/]
];

function locationIdentity(value) {
  const normalized = clean(value);
  if (!normalized) return null;
  const state = locationAliases.find(([, expression]) => expression.test(normalized))?.[0] || null;
  const city = normalized.match(/\b(melbourne|sydney|brisbane|perth|adelaide|canberra|hobart|launceston|darwin)\b/)?.[1] || null;
  const australiaOnly = /\baustralia\b/.test(normalized) && !state;
  return { normalized, state, city, australiaOnly };
}

function compatibleLocations(left, right) {
  const a = locationIdentity(left);
  const b = locationIdentity(right);
  if (!a || !b || a.australiaOnly || b.australiaOnly) return false;
  if (a.city && b.city) return a.city === b.city;
  if (a.state && b.state) return a.state === b.state;
  return a.normalized === b.normalized;
}

function canonicalUrl(value, source) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    if (source === "indeed") {
      const id = url.searchParams.get("jk") || url.searchParams.get("vjk");
      return id ? `indeed:job:${clean(id)}` : `${url.hostname.toLowerCase()}${url.pathname}`;
    }
    if (source === "linkedin") {
      const id = url.pathname.match(/\/jobs\/view\/(\d+)/)?.[1]
        || url.searchParams.get("currentJobId");
      return id ? `linkedin:job:${clean(id)}` : `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
    }
    if (source === "seek") {
      const id = url.pathname.match(/\/job\/(\d+)/)?.[1];
      return id ? `seek:job:${clean(id)}` : `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
    }
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

export function strongIdentityKeys(job) {
  const source = clean(job?.source);
  const keys = [];
  if (source && job?.origin === "tampermonkey-history-migration" && job?.legacyKey) {
    keys.push(`${source}:legacy:${clean(job.legacyKey)}`);
  }
  const fallbackId = /^(?:job|legacy_history)_/i.test(String(job?.id || "")) ? "" : job?.id;
  const sourceJobId = clean(job?.sourceJobId || job?.jobId || fallbackId);
  if (source && sourceJobId) keys.push(`${source}:id:${sourceJobId}`);
  const url = canonicalUrl(job?.jobUrl || job?.link, source);
  if (source && url) keys.push(`${source}:url:${url}`);
  return [...new Set(keys)];
}

export function crossPlatformIdentity(job) {
  if (job?.opaque) return null;
  const title = clean(job?.title);
  const company = companyName(job?.company);
  const location = locationIdentity(job?.location);
  if (title.length < 5 || company.length < 2 || !location || location.australiaOnly) return null;
  return { title, company, location };
}

export function duplicateMatch(candidate, existing) {
  if (!candidate || !existing || candidate === existing) return null;
  if (candidate.id && candidate.id === existing.id) {
    return { type: "same-record-id", confidence: "exact", key: String(candidate.id) };
  }
  const candidateKeys = strongIdentityKeys(candidate);
  const existingKeys = new Set(strongIdentityKeys(existing));
  const exactKey = candidateKeys.find((key) => existingKeys.has(key));
  if (exactKey) return { type: "same-source-id", confidence: "exact", key: exactKey };

  if (!candidate.source || !existing.source || candidate.source === existing.source) return null;
  const left = crossPlatformIdentity(candidate);
  const right = crossPlatformIdentity(existing);
  if (!left || !right || left.title !== right.title || left.company !== right.company) return null;
  if (!compatibleLocations(candidate.location, existing.location)) return null;
  return {
    type: "cross-platform-exact-role",
    confidence: "high",
    key: `${left.company}|${left.title}|${left.location.state || left.location.city}`
  };
}

export function findDuplicate(candidate, existingRecords = []) {
  for (let index = existingRecords.length - 1; index >= 0; index -= 1) {
    const existing = existingRecords[index];
    const match = duplicateMatch(candidate, existing);
    if (match) return { existing, ...match };
  }
  return null;
}
