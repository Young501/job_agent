import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const newId = (prefix) => `${prefix}_${randomUUID()}`;

const clone = (value) => JSON.parse(JSON.stringify(value));

export function createDefaultState(settings, taskCategories = []) {
  return {
    version: 1,
    settings: clone(settings),
    profiles: [],
    activeProfileId: null,
    jobs: [],
    runs: [],
    routineTasks: [],
    validations: [],
    taskCategories: clone(taskCategories),
    importBatches: [],
    reviewReflections: [],
    preferenceModel: null,
    exclusionSuggestions: [],
    profileContexts: {},
    coverLetters: [],
    legacyWorkerHistory: [],
    workerHistoryMigrations: []
  };
}

function mergeTaskCategories(defaultCategories, savedCategories) {
  if (!Array.isArray(savedCategories)) return clone(defaultCategories);
  const savedById = new Map(savedCategories.map((category) => [category?.id, category]));
  const builtins = defaultCategories.map((category) => {
    const saved = savedById.get(category.id);
    const savedTasks = new Map((saved?.tasks ?? []).map((task) => [task?.id, task]));
    return {
      ...clone(category),
      tasks: category.tasks.map((task) => ({
        ...clone(task),
        validationId: savedTasks.get(task.id)?.validationId ?? null
      }))
    };
  });
  const custom = savedCategories.filter((category) => category && !category.builtin && !defaultCategories.some((preset) => preset.id === category.id));
  return [...builtins, ...clone(custom)];
}

export function createStorage({ dataDirectory, defaultSettings, defaultTaskCategories = [] }) {
  const statePath = join(dataDirectory, "state.json");
  let updateQueue = Promise.resolve();

  async function ensureState() {
    await mkdir(dataDirectory, { recursive: true });
    try {
      const raw = await readFile(statePath, "utf8");
      const state = JSON.parse(raw);
      return {
        ...createDefaultState(defaultSettings, defaultTaskCategories),
        ...state,
        settings: { ...clone(defaultSettings), ...(state.settings ?? {}) },
        profiles: Array.isArray(state.profiles) ? state.profiles : [],
        jobs: Array.isArray(state.jobs) ? state.jobs : [],
        runs: Array.isArray(state.runs) ? state.runs : [],
        routineTasks: Array.isArray(state.routineTasks) ? state.routineTasks : [],
        validations: Array.isArray(state.validations) ? state.validations : [],
        taskCategories: mergeTaskCategories(defaultTaskCategories, state.taskCategories),
        importBatches: Array.isArray(state.importBatches) ? state.importBatches : [],
        reviewReflections: Array.isArray(state.reviewReflections) ? state.reviewReflections : [],
        preferenceModel: state.preferenceModel && typeof state.preferenceModel === "object" ? state.preferenceModel : null,
        exclusionSuggestions: Array.isArray(state.exclusionSuggestions) ? state.exclusionSuggestions : [],
        profileContexts: state.profileContexts && typeof state.profileContexts === "object" && !Array.isArray(state.profileContexts)
          ? state.profileContexts
          : {},
        coverLetters: Array.isArray(state.coverLetters) ? state.coverLetters : [],
        legacyWorkerHistory: Array.isArray(state.legacyWorkerHistory) ? state.legacyWorkerHistory : [],
        workerHistoryMigrations: Array.isArray(state.workerHistoryMigrations) ? state.workerHistoryMigrations : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const state = createDefaultState(defaultSettings, defaultTaskCategories);
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

  function update(mutator) {
    const operation = updateQueue.then(async () => {
      const state = await ensureState();
      const result = await mutator(state);
      await write(state);
      return result;
    });
    updateQueue = operation.catch(() => {});
    return operation;
  }

  return { ensureState, update };
}
