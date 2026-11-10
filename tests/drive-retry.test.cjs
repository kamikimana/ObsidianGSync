// Verify that transient Drive API errors cannot duplicate write requests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

let handler;
let requests = [];
const filename = path.resolve(__dirname, "../src/drive.ts");
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const mod = new Module(filename, module);
mod.require = name => name === "obsidian" ? {
  requestUrl: async opts => {
    requests.push(opts);
    return handler(opts);
  }
} : require(name);
mod._compile(code, filename + ".js");
const { DriveClient } = mod.exports;
global.window = { setTimeout: callback => { callback(); return 1; } };

function setup(fn) {
  requests = [];
  handler = fn;
  return new DriveClient(async () => "token");
}

test("folder creation HTTP 503 is not blindly retried", async () => {
  const drive = setup(() => ({ status: 503, text: "temporary failure" }));
  await assert.rejects(drive.createFolder("notes", "root"), /Drive API 503/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
});

test("file creation HTTP 503 is not blindly retried", async () => {
  const drive = setup(() => ({ status: 503, text: "temporary failure" }));
  await assert.rejects(drive.createFile("note.md", "root", new ArrayBuffer(2)), /Drive API 503/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
});

test("file update HTTP 503 is not blindly retried", async () => {
  const drive = setup(() => ({ status: 503, text: "temporary failure" }));
  await assert.rejects(drive.updateFile("id1", new ArrayBuffer(2)), /Drive API 503/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
});

test("Drive GET HTTP 503 is retried and eventually succeeds", async () => {
  let attempt = 0;
  const drive = setup(() => ++attempt < 3
    ? { status: 503, text: "temporary failure" }
    : { status: 200, json: { files: [] } });
  assert.deepEqual(await drive.listChildren("root"), []);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.method === "GET"));
});

test("Drive GET network rejection is retried, but writes are never replayed", async () => {
  let attempt = 0;
  const drive = setup(() => {
    if (++attempt < 3) throw new Error("socket disconnected");
    return { status: 200, json: { files: [] } };
  });
  assert.deepEqual(await drive.listChildren("root"), []);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.method === "GET"));

  const unsafe = setup(() => { throw new Error("socket disconnected"); });
  await assert.rejects(unsafe.createFolder("new", "root"), /socket disconnected/);
  assert.equal(requests.length, 1);
});

test("Drive file list pagination includes short intermediate pages", async () => {
  const drive = setup(opts => {
    const token = new URL(opts.url).searchParams.get("pageToken");
    return token
      ? { status: 200, json: { files: [{ id: "two", name: "second.md" }] } }
      : { status: 200, json: { files: [{ id: "one", name: "first.md" }], nextPageToken: "page-two" } };
  });
  const files = await drive.listChildren("root");
  assert.deepEqual(files.map(f => f.id), ["one", "two"]);
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.includes("incompleteSearch"));
});

test("Drive incompleteSearch aborts instead of treating missing files as deletions", async () => {
  const drive = setup(() => ({ status: 200, json: { files: [], incompleteSearch: true } }));
  await assert.rejects(drive.listChildren("root"), /listing is incomplete/);
});

test("Drive listTree detects duplicate folder names", async () => {
  const drive = setup(opts => {
    const folderId = new URL(opts.url).searchParams.get("q");
    if (folderId.includes("'root'")) {
      return { status: 200, json: { files: [
        { id: "folder1", name: "Folder", mimeType: "application/vnd.google-apps.folder" },
        { id: "folder2", name: "Folder", mimeType: "application/vnd.google-apps.folder" }
      ] } };
    }
    return { status: 200, json: { files: [] } };
  });
  const tree = await drive.listTree("root");
  assert.deepEqual(tree.warnings, ["Duplicate folder name in Drive: Folder"]);
});
