import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const newId = (prefix) => `${prefix}_${randomUUID()}`;

const clone = (value) => JSON.parse(JSON.stringify(value));

export function createDefaultState(settings) {
  return {
    version: 1,
    settings: clone(settings),
    profiles: [],
    activeProfileId: null,
    jobs: [],
    runs: [],
    importBatches: []
  };
}

export function createStorage({ dataDirectory, defaultSettings }) {
  const statePath = join(dataDirectory, "state.json");

  async function ensureState() {
    await mkdir(dataDirectory, { recursive: true });
    try {
      const raw = await readFile(statePath, "utf8");
      const state = JSON.parse(raw);
      return {
        ...createDefaultState(defaultSettings),
        ...state,
        settings: { ...clone(defaultSettings), ...(state.settings ?? {}) },
        profiles: Array.isArray(state.profiles) ? state.profiles : [],
        jobs: Array.isArray(state.jobs) ? state.jobs : [],
        runs: Array.isArray(state.runs) ? state.runs : [],
        importBatches: Array.isArray(state.importBatches) ? state.importBatches : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const state = createDefaultState(defaultSettings);
      await write(state);
      return state;
    }
  }

  async function write(state) {
    await mkdir(dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  }

  async function update(mutator) {
    const state = await ensureState();
    const result = await mutator(state);
    await write(state);
    return result;
  }

  return { ensureState, update };
}
