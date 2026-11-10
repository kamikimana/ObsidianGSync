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

function fixture(localFiles, remoteFiles, state = {}, propagateDeletes = true, overrides = {}) {
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
    getFile: async id => [...remote.values()].find(r => r.id === id),
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
  Object.assign(drive, overrides.drive ?? {});
  Object.assign(vault, overrides.vault ?? {});
  Object.assign(hooks, overrides.hooks ?? {});
  return { local, remote, drive, state, hooks, changes, run: () => runSync(app, drive, settings, state, hooks) };
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

test("empty local vault stops before mass remote deletion", async () => {
  const s = fixture([], [["note.md", "remote"]], {
    "note.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 6 }
  });
  await assert.rejects(s.run(), /Safety stop: the local vault/);
  assert.deepEqual(s.changes, []);
  assert.equal(s.remote.has("note.md"), true);
});

test("empty local vault still downloads when deletion propagation is disabled", async () => {
  const s = fixture([], [["note.md", "remote"]], {
    "note.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 6 }
  }, false);
  assert.equal((await s.run()).downloaded, 1);
  assert.equal(s.local.get("note.md").data.toString(), "remote");
});

test("local edit during download prevents stale remote overwrite", async () => {
  let s;
  s = fixture([["note.md", "original"]], [["note.md", "remote", "r2"]], {
    "note.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 8 }
  }, true, { drive: { download: async () => {
    const f = s.local.get("note.md");
    f.data = Buffer.from("user edit");
    f.stat = { mtime: 200, size: 9 };
    return buffer(Buffer.from("remote"));
  } } });
  const result = await s.run();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /changed during download/);
  assert.equal(s.local.get("note.md").data.toString(), "user edit");
  assert.deepEqual(s.changes, []);
});

test("local edit before remote deletion prevents trashing changed file", async () => {
  let s;
  s = fixture([["keep.md", "keep"], ["note.md", "original"]], [["keep.md", "keep"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "note.md": { remoteId: "old", remoteRev: "r1", localMtime: 100, localSize: 8 }
  }, true, { vault: { adapter: { stat: async p => {
    if (p === "note.md") {
      const f = s.local.get(p);
      f.data = Buffer.from("user edit");
      f.stat = { mtime: 200, size: 9 };
    }
    return s.local.get(p)?.stat ?? null;
  } } } });
  const result = await s.run();
  assert.equal(result.deletedLocal, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(s.local.get("note.md").data.toString(), "user edit");
  assert.deepEqual(s.changes, []);
});

test("network failure during download leaves local data and state unchanged, then retry succeeds", async () => {
  const state = { "note.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 5 } };
  const s = fixture([["note.md", "local"]], [["note.md", "remote", "r2"]], state);
  const download = s.drive.download;
  let failOnce = true;
  s.drive.download = async id => {
    if (failOnce) { failOnce = false; throw new Error("network disconnected"); }
    return download(id);
  };
  const first = await s.run();
  assert.equal(first.errors.length, 1);
  assert.equal(s.local.get("note.md").data.toString(), "local");
  assert.equal(state["note.md"].remoteRev, "r1");
  assert.deepEqual(s.changes, []);
  const second = await s.run();
  assert.equal(second.errors.length, 0);
  assert.equal(second.downloaded, 1);
  assert.equal(s.local.get("note.md").data.toString(), "remote");
});

test("network failure during remote trash retains remote file and retries safely", async () => {
  const state = {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "gone.md": { remoteId: "id2", remoteRev: "r1", localMtime: 100, localSize: 6 }
  };
  const s = fixture([["keep.md", "keep"]], [["keep.md", "keep"], ["gone.md", "remote"]], state);
  const trash = s.drive.trash;
  let failOnce = true;
  s.drive.trash = async id => {
    if (failOnce) { failOnce = false; throw new Error("network disconnected"); }
    return trash(id);
  };
  const first = await s.run();
  assert.equal(first.errors.length, 1);
  assert.equal(s.remote.has("gone.md"), true);
  assert.ok(state["gone.md"]);
  assert.equal((await s.run()).deletedRemote, 1);
  assert.equal(s.remote.has("gone.md"), false);
});

test("edit during existing-file upload is not marked as synced", async () => {
  const state = { "note.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 8 } };
  const s = fixture([["note.md", "first", 200]], [["note.md", "original", "r1"]], state);
  const update = s.drive.updateFile;
  let editOnce = true;
  s.drive.updateFile = async (id, data) => {
    const r = await update(id, data);
    if (editOnce) {
      editOnce = false;
      const f = s.local.get("note.md");
      f.data = Buffer.from("second");
      f.stat = { mtime: 300, size: 6 };
    }
    return r;
  };
  assert.equal((await s.run()).uploaded, 1);
  assert.equal(state["note.md"].localMtime, 200);
  assert.equal((await s.run()).uploaded, 1);
  assert.equal(state["note.md"].localMtime, 300);
});

test("edit during first upload remains pending and is uploaded on retry", async () => {
  const s = fixture([["note.md", "first"]], []);
  const create = s.drive.createFile;
  let editOnce = true;
  s.drive.createFile = async (name, parent, data) => {
    const r = await create(name, parent, data);
    if (editOnce) {
      editOnce = false;
      const f = s.local.get("note.md");
      f.data = Buffer.from("second");
      f.stat = { mtime: 200, size: 6 };
    }
    return r;
  };
  assert.equal((await s.run()).uploaded, 1);
  assert.equal(s.state["note.md"].localMtime, 100);
  assert.equal((await s.run()).uploaded, 1);
  assert.equal(s.state["note.md"].localMtime, 200);
});

test("failed conflict backup upload never overwrites either original", async () => {
  const state = { "note.md": { remoteId: "id1", remoteRev: "r0", localMtime: 100, localSize: 8 } };
  const s = fixture([["note.md", "local-new", 200]], [["note.md", "remote-new", "r1"]], state);
  const create = s.drive.createFile;
  let failOnce = true;
  s.drive.createFile = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error("network disconnected"); }
    return create(...args);
  };
  const first = await s.run();
  assert.equal(first.errors.length, 1);
  assert.equal(s.local.get("note.md").data.toString(), "local-new");
  assert.equal(Buffer.from(await s.drive.download("id1")).toString(), "remote-new");
  assert.equal(s.changes.some(([action, p]) => action === "updateRemote" && p === "note.md"), false);
  const second = await s.run();
  assert.equal(second.errors.length, 0);
  assert.deepEqual(second.conflicts, ["note.md"]);
  assert.equal(Buffer.from(await s.drive.download("id1")).toString(), "local-new");
  assert.equal([...s.local.keys()].some(p => p.includes("(conflict ")), true);
});

test("checkpoint failure aborts further transfers and resumed sync finishes without duplicates", async () => {
  const names = Array.from({ length: 11 }, (_, i) => [`file-${String(i).padStart(2, "0")}.md`, "content"]);
  const s = fixture(names, [], {}, true, { hooks: { checkpoint: async () => { throw new Error("storage unavailable"); } } });
  await assert.rejects(s.run(), /storage unavailable/);
  assert.equal(s.remote.size, 10);
  assert.equal(Object.keys(s.state).length, 10);
  s.hooks.checkpoint = async () => {};
  const result = await s.run();
  assert.equal(result.errors.length, 0);
  assert.equal(s.remote.size, 11);
  assert.equal(Object.keys(s.state).length, 11);
  assert.equal(s.changes.filter(([action]) => action === "createRemote").length, 11);
});

test("remote deletion concurrent with local edit restores changed local file", async () => {
  const s = fixture([["keep.md", "keep"], ["note.md", "edited", 200]], [["keep.md", "keep"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "note.md": { remoteId: "old", remoteRev: "r1", localMtime: 100, localSize: 8 }
  });
  const result = await s.run();
  assert.equal(result.uploaded, 1);
  assert.equal(result.deletedLocal, 0);
  assert.equal(s.local.get("note.md").data.toString(), "edited");
  assert.equal(s.remote.has("note.md"), true);
});

test("local deletion concurrent with remote edit restores changed remote file", async () => {
  const s = fixture([["keep.md", "keep"]], [["keep.md", "keep"], ["note.md", "remote-new", "r2"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "note.md": { remoteId: "id2", remoteRev: "r1", localMtime: 100, localSize: 8 }
  });
  const result = await s.run();
  assert.equal(result.downloaded, 1);
  assert.equal(result.deletedRemote, 0);
  assert.equal(s.local.get("note.md").data.toString(), "remote-new");
});

test("fresh Drive metadata prevents trashing a remotely edited file", async () => {
  const s = fixture([["keep.md", "keep"]], [["keep.md", "keep"], ["note.md", "remote", "r1"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "note.md": { remoteId: "id2", remoteRev: "r1", localMtime: 100, localSize: 6 }
  }, true, { drive: { getFile: async id => ({ id, md5Checksum: "r2" }) } });
  const result = await s.run();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Drive file changed/);
  assert.equal(result.deletedRemote, 0);
  assert.equal(s.remote.has("note.md"), true);
});

test("new local file appearing during download is not overwritten", async () => {
  let s;
  s = fixture([["keep.md", "keep"]], [["keep.md", "keep"], ["note.md", "remote", "r2"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "note.md": { remoteId: "id2", remoteRev: "r1", localMtime: 100, localSize: 6 }
  }, true, { drive: { download: async () => {
    s.local.set("note.md", new TFile("note.md", "new-local", 200));
    return buffer(Buffer.from("remote"));
  } } });
  const result = await s.run();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /appeared during download/);
  assert.equal(s.local.get("note.md").data.toString(), "new-local");
  assert.equal(s.changes.some(([action]) => action === "modifyLocal"), false);
});

test("duplicate Drive names stop sync before any writes", async () => {
  const s = fixture([["note.md", "local", 200]], [["note.md", "remote", "r2"]], {
    "note.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 5 }
  });
  const listTree = s.drive.listTree;
  s.drive.listTree = async id => ({
    ...await listTree(id),
    warnings: ["Duplicate name in Drive, ignoring extra copy: note.md"]
  });
  await assert.rejects(s.run(), /Safety stop: duplicate names/);
  assert.deepEqual(s.changes, []);
});

test("replacement remote file with same checksum is not deleted by stale state", async () => {
  const s = fixture([["keep.md", "keep"]], [["keep.md", "keep"], ["note.md", "remote", "r1"]], {
    "keep.md": { remoteId: "id1", remoteRev: "r1", localMtime: 100, localSize: 4 },
    "note.md": { remoteId: "old-id", remoteRev: "r1", localMtime: 100, localSize: 6 }
  });
  const result = await s.run();
  assert.equal(result.deletedRemote, 0);
  assert.equal(result.downloaded, 1);
  assert.equal(s.local.get("note.md").data.toString(), "remote");
});
