// Dependency-free sync safety regression tests: node --test tests/sync-safety.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
let ts;
try { ts = require("typescript"); }
catch {
  const { execFileSync } = require("node:child_process");
  ts = require(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "typescript"));
}
class TFile {
  constructor(path, text, mtime = 100) {
    this.path = path;
    this.data = Buffer.from(text);
    this.stat = { mtime, size: this.data.length };
  }
}
const filename = path.resolve(__dirname, "../src/sync.ts");
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(filename, module);
mod.require = (name) => name === "obsidian" ? { TFile } : require(name);
mod._compile(code, filename + ".js");
const { runSync } = mod.exports;
const buffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function fixture(localFiles, remoteFiles, state = {}, propagateDeletes = true) {
  const local = new Map(localFiles.map(([p, t, m = 100]) => [p, new TFile(p, t, m)]));
  const remote = new Map();
  const payloads = new Map();
  const changes = [];
  const folders = new Set();
  let nextId = 1;
  for (const [p, t, rev = "r1"] of remoteFiles) {
    const id = "id" + nextId++;
    remote.set(p, { id, name: p.split("/").pop(), mimeType: "text/markdown", md5Checksum: rev, modifiedTime: rev, size: String(Buffer.byteLength(t)) });
    payloads.set(id, Buffer.from(t));
  }
  const vault = {
    configDir: ".obsidian",
    getFiles: () => [...local.values()],
    getAbstractFileByPath: p => local.get(p) ?? (folders.has(p) ? { path: p } : null),
    adapter: { stat: async p => local.get(p)?.stat ?? null },
    readBinary: async f => buffer(f.data),
    createFolder: async p => { folders.add(p); },
    createBinary: async (p, bytes) => {
      assert.equal(local.has(p), false, "must not overwrite existing local conflict copy");
      local.set(p, new TFile(p, Buffer.from(bytes).toString(), 500));
      changes.push(["createLocal", p]);
    },
    modifyBinary: async (f, bytes) => {
      f.data = Buffer.from(bytes);
      f.stat = { mtime: 500, size: f.data.length };
      changes.push(["modifyLocal", f.path]);
    }
  };
  const drive = {
    ensureFolderPath: async () => "root",
    listTree: async () => ({ files: new Map(remote), folders: new Map([["", "root"]]), warnings: [] }),
    download: async id => buffer(payloads.get(id)),
    createFolder: async (name, parent) => parent + "/" + name,
    createFile: async (name, parent, bytes) => {
      const p = (parent === "root" ? "" : parent.slice(5) + "/") + name;
      assert.equal(remote.has(p), false, "must not overwrite existing remote conflict copy");
      const id = "id" + nextId++;
      const data = Buffer.from(bytes);
      const item = { id, name, mimeType: "text/markdown", modifiedTime: "new-" + id, md5Checksum: "new-" + id, size: String(data.length) };
      remote.set(p, item);
      payloads.set(id, data);
      changes.push(["createRemote", p]);
      return item;
    },
    updateFile: async (id, bytes) => {
      const p = [...remote].find(([, r]) => r.id === id)?.[0];
      assert.ok(p);
      payloads.set(id, Buffer.from(bytes));
      const item = { ...remote.get(p), md5Checksum: "updated" + id };
      remote.set(p, item);
      changes.push(["updateRemote", p]);
      return item;
    },
    trash: async id => {
      const p = [...remote].find(([, r]) => r.id === id)?.[0];
      remote.delete(p);
      changes.push(["trashRemote", p]);
    }
  };
  const app = { vault, fileManager: { trashFile: async f => {
    local.delete(f.path);
    changes.push(["trashLocal", f.path]);
  } } };
  const settings = { maxFileSizeMB: 25, excludes: "", remoteFolder: "Obsidian/Notes", propagateDeletes };
  const hooks = { checkpoint: async () => {}, progress: () => {} };
  return { local, remote, changes, run: () => runSync(app, drive, settings, state, hooks) };
}
test("missing remote root content stops before any deletion", async () => {
  const s = fixture([["note.md", "important"]], [], { "note.md": { remoteId: "old", remoteRev: "r0", localMtime: 100, localSize: 9 } });
  await assert.rejects(s.run(), /Safety stop/);
  assert.equal(s.local.get("note.md").data.toString(), "important");
  assert.deepEqual(s.changes, []);
});
test("first upload to an empty remote folder is allowed", async () => {
  const s = fixture([["note.md", "hello"]], []);
  assert.equal((await s.run()).uploaded, 1);
});
test("conflict backup name collision cannot overwrite preexisting backup", async () => {
  const RealDate = global.Date, when = Date.parse("2026-11-10T14:25:00.000Z");
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [when])); }
    static now() { return when; }
  };
  try {
    const d = new Date(when);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(),3)}`;
    const previous = `note (conflict ${stamp}).md`;
    const s = fixture([["note.md", "local-new", 200], [previous, "KEEP"]], [["note.md", "remote-new", "r1"]], {
      "note.md": { remoteId: "id1", remoteRev: "r0", localMtime: 100, localSize: 7 }
    }, false);
    assert.deepEqual((await s.run()).conflicts, ["note.md"]);
    assert.equal(s.local.get(previous).data.toString(), "KEEP");
    assert.equal(s.local.get(`note (conflict ${stamp}-1).md`).data.toString(), "remote-new");
  } finally { global.Date = RealDate; }
});
test("ordinary remote deletion still propagates when other files remain", async () => {
  const s = fixture([["keep.md", "here"], ["gone.md", "bye"]], [["keep.md", "here", "r1"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "gone.md": { remoteId: "old", remoteRev: "r1", localMtime: 100, localSize: 3 }
  });
  assert.equal((await s.run()).deletedLocal, 1);
  assert.equal(s.local.has("gone.md"), false);
});
test("deletion sync disabled restores missing remote file", async () => {
  const s = fixture([["note.md", "hello"]], [], {
    "note.md": { remoteId: "old", remoteRev: "r0", localMtime: 100, localSize: 5 }
  }, false);
  assert.equal((await s.run()).uploaded, 1);
});
