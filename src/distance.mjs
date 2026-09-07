import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ttl = 30 * 24 * 60 * 60 * 1000;

export function distanceKm(a, b) {
  const radians = (n) => n * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function jobPlace(job, override = "") {
  if (override) return { query: clean(override), source: "user" };
  if (/\bremote\b/i.test(job.location || "") && !/\bhybrid\b/i.test(job.location || "")) return { status: "REMOTE" };
  if (job.workAddress) return { query: clean(job.workAddress), source: "structured" };
  // Only explicitly labelled workplace addresses qualify; unrelated addresses in a JD do not.
  const labelled = String(job.description || "").match(/\b(?:work address|office address|workplace address)\s*:\s*([^\n;.!?]{8,180})/i)?.[1];
  if (labelled && /\b\d+[a-z]?\s+[\w '\-]+\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd)\b/i.test(labelled)) {
    return { query: clean(labelled), source: "jd" };
  }
  const query = clean(job.location).replace(/\s*\((?:hybrid|on-site|on site)\)/ig, "").trim();
  if (!query || /^(?:australia|all australia|apac|worldwide|anywhere|multiple locations|various locations)$/i.test(query)) return { status: "MISSING" };
  if (/\s(?:or|and|&)\s|[;/]|\bmultiple\b/i.test(query)) return { status: "AMBIGUOUS" };
  return { query, source: "listing" };
}

export function selectDestination(candidates) {
  const [best, second] = candidates;
  if (!best) return { status: "NOT_FOUND" };
  if (["country", "state", "county"].includes(best.type)) return { status: "TOO_BROAD" };
  if (best.confidence < 0.6 || (second && best.confidence - second.confidence < 0.1 && distanceKm(best, second) > 1)) {
    return { status: "AMBIGUOUS" };
  }
  return { status: "READY", point: best };
}

export async function createDistanceService({ dataDirectory, fetchImpl = fetch, intervalMs = 1100, timeoutMs = 8000 }) {
  const path = join(dataDirectory, "distance.json");
  let saved;
  try { saved = JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let config = { enabled: false, homeAddress: "", country: "au", apiKey: "", origin: null, ...saved?.config };
  let cache = saved?.cache || {};
  let results = saved?.results || {};
  let overrides = saved?.overrides || {};
  let candidates = [];
  let batch = null;
  let active = null;
  let lookupActive = false;
  let revision = 0;
  let nextRequestAt = 0;
  let writes = Promise.resolve();

  function persist() {
    const content = JSON.stringify({ config, cache, results, overrides }, null, 2) + "\n";
    const operation = writes.then(async () => {
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(path + ".tmp", content, { mode: 0o600 });
      await rename(path + ".tmp", path);
    });
    writes = operation.catch(() => {});
    return operation;
  }

  const signature = (job) => hash(JSON.stringify([config.origin, jobPlace(job, overrides[job.id])]));
  function snapshot(jobs = []) {
    const publicResults = {};
    if (config.enabled) for (const job of jobs) {
      const item = results[job.id];
      if (item?.signature === signature(job) && Date.now() - Date.parse(item.updatedAt) < ttl) publicResults[job.id] = item;
    }
    return {
      enabled: config.enabled, homeAddress: config.homeAddress, country: config.country,
      hasApiKey: Boolean(config.apiKey), origin: config.origin,
      results: publicResults, overrides, batch: batch ? { ...batch } : null
    };
  }

  async function saveConfig(input) {
    if (lookupActive) throw new Error("Address lookup is still running.");
    active?.abort();
    revision += 1;
    if (batch?.status === "RUNNING") batch.status = "CANCELLED";
    const next = {
      enabled: input.enabled === true,
      homeAddress: clean(input.homeAddress),
      country: /^[a-z]{2}$/i.test(input.country || "") ? input.country.toLowerCase() : "au",
      apiKey: input.clearApiKey ? "" : clean(input.apiKey) || config.apiKey,
      origin: config.origin
    };
    if (next.homeAddress !== config.homeAddress || next.country !== config.country) {
      next.origin = null;
      candidates = [];
      results = {};
      cache = {};
    }
    config = next;
    await persist();
    return snapshot();
  }

  function requireEnabled() {
    if (!config.enabled) throw new Error("Distance lookup is disabled.");
    if (!config.apiKey) throw new Error("Configure a Geoapify API key first.");
  }

  async function geocode(query, signal) {
    const key = hash(config.country + ":" + query.toLowerCase());
    if (cache[key] && Date.now() - cache[key].at < ttl) return cache[key].items;
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    nextRequestAt = Date.now() + intervalMs;
    const url = new URL("https://api.geoapify.com/v1/geocode/search");
    url.search = new URLSearchParams({ text: query, format: "json", limit: "5", lang: "en", filter: "countrycode:" + config.country, apiKey: config.apiKey });
    let response;
    try {
      response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Geocoding timed out or could not connect. Try again later.");
    }
    if (!response.ok) {
      // Never surface provider response bodies or request URLs: they may echo the API key or home address.
      throw new Error(`Geocoding service returned HTTP ${response.status}. Check the API key or quota.`);
    }
    let data;
    try { data = await response.json(); } catch { throw new Error("Geocoding service returned invalid data."); }
    signal?.throwIfAborted();
    if (!Array.isArray(data.results)) throw new Error("Geocoding service returned invalid data.");
    const items = data.results.filter((item) => typeof item.lat === "number" && typeof item.lon === "number"
      && Number.isFinite(item.lat) && Math.abs(item.lat) <= 90 && Number.isFinite(item.lon) && Math.abs(item.lon) <= 180)
      .map((item) => ({ lat: item.lat, lon: item.lon, label: clean(item.formatted), type: clean(item.result_type),
        confidence: Number(item.rank?.confidence) || 0,
        precise: ["building", "amenity"].includes(item.result_type) && Boolean(item.housenumber) }));
    cache[key] = { at: Date.now(), items };
    const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, 2000);
    cache = Object.fromEntries(entries);
    return items;
  }

  async function findOrigin() {
    requireEnabled();
    if (!config.homeAddress) throw new Error("Enter a home address first.");
    if (lookupActive || batch?.status === "RUNNING") throw new Error("A distance lookup is already running.");
    lookupActive = true;
    try {
      candidates = (await geocode(config.homeAddress)).filter((item) => !["country", "state", "county"].includes(item.type));
      await persist();
      return { candidates };
    } finally { lookupActive = false; }
  }

  async function confirmOrigin(index) {
    requireEnabled();
    if (!Number.isInteger(index) || !candidates[index]) throw new Error("Search for the home address and choose a returned location.");
    if (batch?.status === "RUNNING") throw new Error("Stop the current distance lookup first.");
    config.origin = candidates[index];
    results = {};
    await persist();
    return snapshot();
  }

  async function setOverride(job, address) {
    if (batch?.status === "RUNNING") throw new Error("Stop the current distance lookup before editing an address.");
    const value = clean(address);
    if (value) overrides[job.id] = value;
    else delete overrides[job.id];
    delete results[job.id];
    await persist();
    return snapshot([job]);
  }

  async function start(jobs) {
    requireEnabled();
    if (!config.origin) throw new Error("Confirm the home address location in Search Settings first.");
    if (batch?.status === "RUNNING" || lookupActive) throw new Error("A distance lookup is already running.");
    if (!jobs.length || jobs.length > 500) throw new Error("Choose between 1 and 500 jobs for a distance lookup.");
    const id = ++revision;
    const controller = new AbortController();
    active = controller;
    const current = { status: "RUNNING", total: jobs.length, completed: 0, currentTitle: "", error: null };
    batch = current;
    const completion = (async () => {
      try {
        for (const job of jobs) {
          controller.signal.throwIfAborted();
          current.currentTitle = job.title;
          const place = jobPlace(job, overrides[job.id]);
          const stamp = signature(job);
          const existing = results[job.id];
          if (!existing || existing.signature !== stamp || Date.now() - Date.parse(existing.updatedAt) >= ttl) {
            const destination = place.status ? { status: place.status } : selectDestination(await geocode(place.query, controller.signal));
            controller.signal.throwIfAborted();
            if (id !== revision) break;
            results[job.id] = {
              ...destination, signature: stamp, query: place.query || "", source: place.source || null,
              km: destination.point ? distanceKm(config.origin, destination.point) : null,
              approximate: destination.point ? !destination.point.precise || !config.origin.precise : true,
              updatedAt: new Date().toISOString()
            };
          }
          current.completed += 1;
          await persist();
        }
        if (id === revision && !controller.signal.aborted) current.status = "COMPLETED";
      } catch (error) {
        current.status = controller.signal.aborted ? "CANCELLED" : "FAILED";
        current.error = controller.signal.aborted ? null : error.message;
      } finally {
        current.currentTitle = "";
        if (id === revision) active = null;
      }
    })();
    return { batch: { ...current }, completion };
  }

  function cancel() {
    active?.abort();
    if (batch?.status === "RUNNING") batch.status = "CANCELLED";
    return snapshot();
  }

  return { snapshot, saveConfig, findOrigin, confirmOrigin, setOverride, start, cancel };
}
