// Plugin lifecycle regression tests with a minimal Obsidian mock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

let stored = {};
let runCount = 0;
let saveCount = 0;
let failSaves = new Set();
let intervals = [];
let layoutReady;
const notices = [];

class Plugin {
  constructor() {
    this.app = {
      vault: { getName: () => "GSync-Test" },
      workspace: { onLayoutReady: callback => { layoutReady = callback; } }
    };
  }
  async loadData() { return stored; }
  async saveData(data) {
    saveCount++;
    if (failSaves.has(saveCount)) throw new Error("storage unavailable");
    stored = structuredClone(data);
  }
  addSettingTab() {}
  addStatusBarItem() { return { setText() {} }; }
  addRibbonIcon() {}
  addCommand() {}
  registerObsidianProtocolHandler() {}
  registerInterval() {}
}
class Notice {
  constructor(message) { notices.push(message); }
  hide() {}
  setMessage() {}
}
class GSyncSettingTab { refresh() {} }
class DriveClient {}

const defaults = {
  clientId: "client", clientSecret: "secret", refreshToken: "token",
  remoteFolder: "GSync-Test", autoSyncMinutes: 1, syncOnStartup: true,
  propagateDeletes: false, maxFileSizeMB: 25, excludes: ""
};

const filename = path.resolve(__dirname, "../src/main.ts");
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(filename, module);
mod.require = name => {
  if (name === "obsidian") return { Plugin, Notice, Platform: { isMobile: false } };
  if (name === "./settings") return { DEFAULT_SETTINGS: defaults, GSyncSettingTab };
  if (name === "./drive") return { DriveClient };
  if (name === "./sync") return {
    runSync: async () => {
      runCount++;
      return { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
        conflicts: [], errors: [], warnings: [], skipped: [] };
    }
  };
  if (name === "./auth") return {};
  return require(name);
};
mod._compile(code, filename + ".js");
const GSyncPlugin = mod.exports.default;

global.window = {
  setInterval: fn => { intervals.push(fn); return intervals.length; },
  clearInterval() {},
  setTimeout() { return 1; }
};

async function start(data, failedSaveNumbers = []) {
  stored = structuredClone(data);
  runCount = 0;
  saveCount = 0;
  failSaves = new Set(failedSaveNumbers);
  intervals = [];
  notices.length = 0;
  layoutReady = null;
  const plugin = new GSyncPlugin();
  await plugin.onload();
  assert.equal(typeof layoutReady, "function");
  return plugin;
}

test("interrupted session blocks both startup and timer sync until manual resume", async () => {
  const plugin = await start({ settings: defaults, syncInProgress: true });
  layoutReady();
  assert.match(notices.join(" "), /manual sync to resume/);
  assert.equal(intervals.length, 1);
  intervals[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 0);
  await plugin.sync(true);
  assert.equal(runCount, 0);
  await plugin.sync(false);
  assert.equal(runCount, 1);
  assert.equal(stored.syncInProgress, false);
  intervals[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 2);
});

test("failure saving initial in-progress marker prevents transfers and unlocks retry", async () => {
  const plugin = await start({ settings: defaults }, [1]);
  const originalError = console.error;
  console.error = () => {};
  try {
    await plugin.sync(false);
    assert.equal(runCount, 0);
    assert.equal(stored.syncInProgress, false);
    await plugin.sync(false);
    assert.equal(runCount, 1);
    assert.equal(stored.syncInProgress, false);
  } finally { console.error = originalError; }
});

test("failed final checkpoint is retried and does not lock further syncs", async () => {
  const plugin = await start({ settings: defaults }, [2]);
  const originalError = console.error;
  console.error = () => {};
  try {
    await plugin.sync(false);
    assert.equal(runCount, 1);
    assert.equal(stored.syncInProgress, false);
    assert.ok(saveCount >= 3, "final checkpoint should be retried");
    await plugin.sync(false);
    assert.equal(runCount, 2);
  } finally { console.error = originalError; }
});
