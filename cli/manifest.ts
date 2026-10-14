import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Editor } from "./api.ts";
import { sha256 } from "./util.ts";

export const MANIFEST = ".codepen-sync.json";

/** Local-only paths that are never synced to CodePen. */
const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", ".vite"]);
const IGNORED_FILES = new Set([MANIFEST, ".DS_Store", "Thumbs.db"]);

export interface ManifestFile {
  id: string;
  /** sha256 of the bytes on disk at the last sync. */
  hash: string;
  /** CodePen's content_hash at the last sync, used to skip re-downloading unchanged binaries. */
  remote_hash: string;
  binary: boolean;
}

export interface Manifest {
  id: string;
  editor: Editor;
  title: string;
  url: string;
  /** Head version at the last sync (null for Classic Pens). */
  version_id: string | null;
  /** Pen updated_at at the last sync; the only change signal for Classic Pens. */
  updated_at: string;
  synced_at: string;
  files: Record<string, ManifestFile>;
}

export async function readManifest(dir: string): Promise<Manifest | null> {
  const file = path.join(dir, MANIFEST);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as Manifest;
}

export async function writeManifest(dir: string, manifest: Manifest) {
  const sorted = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(path.join(dir, MANIFEST), JSON.stringify({ ...manifest, files: sorted }, null, 2) + "\n");
}

export interface LocalFile {
  /** Pen path, e.g. "/src/app.js". */
  path: string;
  abs: string;
  hash: string;
}

/** Walks a Pen directory and hashes every syncable file. */
export async function scanLocal(dir: string): Promise<Map<string, LocalFile>> {
  const out = new Map<string, LocalFile>();
  async function walk(rel: string) {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(childRel);
      } else if (entry.isFile() && !IGNORED_FILES.has(entry.name)) {
        const abs = path.join(dir, childRel);
        out.set("/" + childRel, { path: "/" + childRel, abs, hash: sha256(await readFile(abs)) });
      }
    }
  }
  if (existsSync(dir)) await walk("");
  return out;
}

export interface LocalDiff {
  added: LocalFile[];
  modified: (LocalFile & { id: string; binary: boolean })[];
  deleted: { path: string; id: string }[];
}

export function diffLocal(manifest: Pick<Manifest, "files">, local: Map<string, LocalFile>): LocalDiff {
  const diff: LocalDiff = { added: [], modified: [], deleted: [] };
  for (const [p, file] of local) {
    const known = manifest.files[p];
    if (!known) diff.added.push(file);
    else if (known.hash !== file.hash) diff.modified.push({ ...file, id: known.id, binary: known.binary });
  }
  for (const [p, known] of Object.entries(manifest.files)) {
    if (!local.has(p)) diff.deleted.push({ path: p, id: known.id });
  }
  for (const list of [diff.added, diff.modified, diff.deleted]) list.sort((a, b) => a.path.localeCompare(b.path));
  return diff;
}

export const isClean = (d: LocalDiff) => !d.added.length && !d.modified.length && !d.deleted.length;

/** Binary detection for files we're about to upload: NUL bytes or invalid UTF-8. */
export function looksBinary(data: Uint8Array): boolean {
  if (data.subarray(0, 8000).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}
