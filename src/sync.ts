import { App, TFile } from "obsidian";
import { DriveClient, RemoteFile, RemoteTree } from "./drive";
import { GSyncSettings } from "./settings";

/** What both sides looked like the last time this path was in sync. */
export interface SyncRecord {
  remoteId: string;
  remoteRev: string;
  localMtime: number;
  localSize: number;
}
export type SyncState = Record<string, SyncRecord>;

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  errors: string[];
  warnings: string[];
  skipped: string[];
}

export interface SyncHooks {
  /** Persist state mid-sync so a crash doesn't lose finished work. */
  checkpoint: () => Promise<void>;
  progress: (done: number, total: number, transferred: number) => void;
}

const rev = (f: RemoteFile) => f.md5Checksum ?? f.modifiedTime;

function parseExcludes(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function isExcluded(path: string, rules: string[], configDir: string): boolean {
  // Never touch the vault config folder (usually .obsidian, but user-configurable)
  // or any hidden file/folder (.trash, .git ...) on either side.
  if (configDir && (path === configDir || path.startsWith(configDir + "/"))) return true;
  if (path.split("/").some((seg) => seg.startsWith("."))) return true;
  const name = path.split("/").pop() ?? path;
  return rules.some((r) => {
    if (r.startsWith("*.")) return path.toLowerCase().endsWith(r.slice(1).toLowerCase());
    if (r.endsWith("/")) return path.startsWith(r);
    return path === r || name === r || path.startsWith(r + "/");
  });
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function conflictPath(path: string, occupied: (candidate: string) => boolean): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  for (let n = 0; n < 10000; n++) {
    const suffix = n ? `-${n}` : "";
    const candidate = `${dir}${base} (conflict ${stamp}${suffix})${ext}`;
    if (!occupied(candidate)) return candidate;
  }
  throw new Error(`Couldn't allocate an unused conflict file name for ${path}`);
}

export async function runSync(
  app: App,
  drive: DriveClient,
  settings: GSyncSettings,
  state: SyncState,
  hooks: SyncHooks
): Promise<SyncResult> {
  const vault = app.vault;
  const res: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], errors: [], warnings: [], skipped: [] };
  const maxBytes = Math.max(0, settings.maxFileSizeMB) * 1024 * 1024;
  const rules = parseExcludes(settings.excludes);
  const configDir = vault.configDir;

  const rootId = await drive.ensureFolderPath(settings.remoteFolder);
  const tree: RemoteTree = await drive.listTree(rootId);
  res.warnings.push(...tree.warnings);
  // Drive allows multiple files with the same name in one folder. Choosing an
  // arbitrary copy could overwrite the wrong version or propagate deletions.
  const unsafePrefixes = [
    "Duplicate name in Drive, ignoring extra copy: ",
    "Duplicate folder name in Drive: ",
    "File/folder name collision in Drive: ",
  ];
  const duplicates = tree.warnings
    .map((w) => {
      const prefix = unsafePrefixes.find((p) => w.startsWith(p));
      return prefix ? w.slice(prefix.length) : null;
    })
    .filter((path): path is string => path !== null && !isExcluded(path, rules, configDir));
  if (duplicates.length) {
    throw new Error(
      `Safety stop: duplicate names in the Drive sync folder (${duplicates.slice(0, 5).join(", ")}). Resolve duplicates before syncing.`
    );
  }

  const local = new Map<string, TFile>();
  for (const f of vault.getFiles()) if (!isExcluded(f.path, rules, configDir)) local.set(f.path, f);
  const remote = tree.files;

  // A removed/recreated Drive root would otherwise look like a mass deletion.
  // Fail closed until the user confirms the folder and resets sync state.
  const trackedPaths = Object.keys(state).filter((p) => !isExcluded(p, rules, configDir));
  const visibleRemoteCount = [...remote.keys()].filter((p) => !isExcluded(p, rules, configDir)).length;
  if (settings.propagateDeletes && trackedPaths.length > 0) {
    if (local.size > 0 && visibleRemoteCount === 0) {
      throw new Error(
        `Safety stop: the Drive sync folder has no syncable files, but ${trackedPaths.length} previously synced file(s) are recorded. Check the Drive folder and backups before resetting sync state.`
      );
    }
    // An unexpectedly empty local vault would otherwise trash every tracked
    // Drive file. Require explicit investigation rather than guessing that
    // the user intentionally deleted all notes.
    if (local.size === 0 && visibleRemoteCount > 0) {
      throw new Error(
        `Safety stop: the local vault has no syncable files, but ${trackedPaths.length} previously synced file(s) are recorded. Check the vault and backups before resetting sync state.`
      );
    }
  }

  // ---- helpers ------------------------------------------------------------
  const record = async (path: string, r: RemoteFile, snapshot?: { mtime: number; size: number }) => {
    const st = snapshot ?? await vault.adapter.stat(path);
    if (!st) return;
    state[path] = { remoteId: r.id, remoteRev: rev(r), localMtime: st.mtime, localSize: st.size };
  };

  // Record the metadata of the bytes actually read, not the metadata of a
  // later local edit that may occur while a Drive upload is in flight.
  const readLocalSnapshot = async (path: string, file: TFile) => {
    const before = await vault.adapter.stat(path);
    if (!before || vault.getAbstractFileByPath(path) !== file) {
      throw new Error("Local file disappeared before upload; skipped.");
    }
    const data = await vault.readBinary(file);
    const after = await vault.adapter.stat(path);
    if (!after || vault.getAbstractFileByPath(path) !== file ||
        before.mtime !== after.mtime || before.size !== after.size) {
      throw new Error("Local file changed while reading; skipped upload. Retry sync.");
    }
    return { data, stat: { mtime: after.mtime, size: after.size } };
  };

  const stillMatches = async (path: string, file: TFile, stat: { mtime: number; size: number }) => {
    const current = await vault.adapter.stat(path);
    return vault.getAbstractFileByPath(path) === file &&
      !!current && current.mtime === stat.mtime && current.size === stat.size;
  };

  const ensureRemoteParent = async (path: string): Promise<string> => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    let parentId = tree.folders.get("") as string;
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      let id = tree.folders.get(cur);
      if (!id) {
        id = await drive.createFolder(p, parentId);
        tree.folders.set(cur, id);
      }
      parentId = id;
    }
    return parentId;
  };

  const ensureLocalParent = async (path: string) => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!vault.getAbstractFileByPath(cur)) await vault.createFolder(cur);
    }
  };

  const writeLocal = async (path: string, data: ArrayBuffer) => {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await vault.modifyBinary(existing, data);
    else {
      await ensureLocalParent(path);
      await vault.createBinary(path, data);
    }
  };

  const uploadNew = async (path: string, data: ArrayBuffer): Promise<RemoteFile> => {
    const parentId = await ensureRemoteParent(path);
    const name = path.split("/").pop() as string;
    return drive.createFile(name, parentId, data);
  };

  const localChangedSince = (f: TFile, s: SyncRecord) => f.stat.mtime !== s.localMtime || f.stat.size !== s.localSize;

  const resolveBothChanged = async (path: string, l: TFile, r: RemoteFile) => {
    const [snapshot, rd] = await Promise.all([readLocalSnapshot(path, l), drive.download(r.id)]);
    const ld = snapshot.data;
    if (sameBytes(ld, rd)) {
      if (!(await stillMatches(path, l, snapshot.stat))) {
        throw new Error("Local file changed during comparison; skipped. Retry sync.");
      }
      await record(path, r, snapshot.stat);
      return;
    }
    // Keep both: local wins the original name, Drive's version is saved beside it.
    const cPath = conflictPath(path, (candidate) =>
      !!vault.getAbstractFileByPath(candidate) || remote.has(candidate) || candidate in state
    );
    await writeLocal(cPath, rd);
    const cRemote = await uploadNew(cPath, rd);
    remote.set(cPath, cRemote);
    await record(cPath, cRemote);
    if (!(await stillMatches(path, l, snapshot.stat))) {
      throw new Error("Local file changed during conflict backup; original Drive file was not overwritten. Retry sync.");
    }
    const updated = await drive.updateFile(r.id, ld);
    await record(path, updated, snapshot.stat);
    res.conflicts.push(path);
  };

  // ---- main pass ----------------------------------------------------------
  const paths = Array.from(new Set([...local.keys(), ...remote.keys(), ...Object.keys(state)])).sort();

  const work = () => res.uploaded + res.downloaded + res.deletedLocal + res.deletedRemote + res.conflicts.length;
  let lastCheckpointWork = 0;
  let lastCheckpointAt = Date.now();
  let done = 0;

  for (const path of paths) {
    done++;
    if (done % 10 === 0) hooks.progress(done, paths.length, work());
    // Save progress every 10 transfers or 5 seconds.
    if (work() - lastCheckpointWork >= 10 || (work() > lastCheckpointWork && Date.now() - lastCheckpointAt > 5000)) {
      await hooks.checkpoint();
      lastCheckpointWork = work();
      lastCheckpointAt = Date.now();
    }
    if (isExcluded(path, rules, configDir)) continue;
    try {
      const l = local.get(path);
      const r = remote.get(path);
      if (maxBytes > 0 && ((l && l.stat.size > maxBytes) || (r && Number(r.size ?? 0) > maxBytes))) {
        res.skipped.push(path);
        continue;
      }
      const s = state[path];

      if (l && r) {
        if (!s) {
          await resolveBothChanged(path, l, r); // first time we've seen both: compare contents
          continue;
        }
        const lChanged = localChangedSince(l, s);
        const rChanged = rev(r) !== s.remoteRev || r.id !== s.remoteId;
        if (lChanged && rChanged) await resolveBothChanged(path, l, r);
        else if (lChanged) {
          const snapshot = await readLocalSnapshot(path, l);
          const updated = await drive.updateFile(r.id, snapshot.data);
          await record(path, updated, snapshot.stat);
          res.uploaded++;
        } else if (rChanged) {
          // Download can take seconds. Do not overwrite an edit made locally
          // while the remote bytes were in flight.
          const beforeMtime = l.stat.mtime;
          const beforeSize = l.stat.size;
          const bytes = await drive.download(r.id);
          const current = vault.getAbstractFileByPath(path);
          const latest = await vault.adapter.stat(path);
          if (!(current instanceof TFile) || !latest ||
              latest.mtime !== beforeMtime || latest.size !== beforeSize) {
            throw new Error("Local file changed during download; skipped overwrite. Retry sync to preserve both versions.");
          }
          await writeLocal(path, bytes);
          await record(path, r);
          res.downloaded++;
        }
      } else if (l && !r) {
        if (s && settings.propagateDeletes && !localChangedSince(l, s)) {
          // Absence from Drive's list is NOT proof of deletion. Listings may
          // temporarily omit items; only propagate a confirmed trash action.
          // Ambiguous 404/permission errors also preserve the local copy.
          const fresh = await drive.getFile(s.remoteId);
          if (!fresh || fresh.trashed !== true) {
            throw new Error("Drive did not confirm the file is in trash; local copy preserved.");
          }
          // A file may change while a sync is running. Recheck the adapter's
          // latest metadata before propagating a remote deletion.
          const latest = await vault.adapter.stat(path);
          if (!latest || latest.mtime !== s.localMtime || latest.size !== s.localSize) {
            throw new Error("Local file changed during sync; skipped deletion. Retry sync.");
          }
          await app.fileManager.trashFile(l); // deleted in Drive -> delete here
          delete state[path];
          res.deletedLocal++;
        } else {
          const snapshot = await readLocalSnapshot(path, l);
          const created = await uploadNew(path, snapshot.data);
          await record(path, created, snapshot.stat);
          res.uploaded++;
        }
      } else if (!l && r) {
        if (s && settings.propagateDeletes && r.id === s.remoteId && rev(r) === s.remoteRev) {
          // The local file may have reappeared, or Drive may have been edited
          // after listTree. Never trash a newly changed copy based on stale data.
          if (vault.getAbstractFileByPath(path) || await vault.adapter.stat(path)) {
            throw new Error("Local file reappeared during sync; skipped remote deletion. Retry sync.");
          }
          const fresh = await drive.getFile(r.id);
          if (fresh.id !== s.remoteId || rev(fresh) !== s.remoteRev) {
            throw new Error("Drive file changed during sync; skipped remote deletion. Retry sync.");
          }
          await drive.trash(r.id); // deleted here -> move to Drive trash
          delete state[path];
          res.deletedRemote++;
        } else {
          const bytes = await drive.download(r.id);
          if (vault.getAbstractFileByPath(path) || await vault.adapter.stat(path)) {
            throw new Error("Local file appeared during download; skipped overwrite. Retry sync.");
          }
          await writeLocal(path, bytes);
          await record(path, r);
          res.downloaded++;
        }
      } else {
        delete state[path]; // gone on both sides
      }
    } catch (e) {
      res.errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  hooks.progress(paths.length, paths.length, work());
  return res;
}
