import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CodePen, CodePenError, type Build, type FileChange, type ListOrder, type Page, type Pen, type PenFile, type PenFilters, type Upload } from "./api.ts";
import {
  diffLocal,
  isClean,
  looksBinary,
  readManifest,
  scanLocal,
  writeManifest,
  type LocalDiff,
  type LocalFile,
  type Manifest,
  type ManifestFile,
} from "./manifest.ts";
import { PENS_DIR, ROOT, UserError, c, confirm, parsePenRef, sha256, slugify, table } from "./util.ts";

export function getClient(): CodePen {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {}
  const key = (process.env.CODEPEN_API_KEY || process.env.CODEPEN || "").trim();
  if (!key) throw new UserError("No API key. Copy .env.example to .env and set CODEPEN_API_KEY (https://codepen.io/settings/api).");
  const bad = [...key].findIndex((ch) => !/[\x21-\x7e]/.test(ch));
  if (bad >= 0) {
    const ch = [...key][bad];
    throw new UserError(
      `CODEPEN_API_KEY contains an invalid character at position ${bad + 1}: ${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}). ` +
        `It was probably copied along with the key; remove it from .env.`,
    );
  }
  return new CodePen({
    key,
    onPoll: (b) => console.log(c.dim(`  build ${b.status.toLowerCase()}…`)),
  });
}

// ---------------------------------------------------------------------------
// Local Pens

export interface LocalPen {
  slug: string;
  dir: string;
  manifest: Manifest;
}

export async function localPens(): Promise<LocalPen[]> {
  if (!existsSync(PENS_DIR)) return [];
  const out: LocalPen[] = [];
  for (const entry of await readdir(PENS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PENS_DIR, entry.name);
    const manifest = await readManifest(dir);
    if (manifest) out.push({ slug: entry.name, dir, manifest });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Pen id → folder slug for every synced Pen. */
export async function localIndex(): Promise<Map<string, string>> {
  return new Map((await localPens()).map((p) => [p.manifest.id, p.slug]));
}

export async function requireLocalPen(slug: string): Promise<LocalPen> {
  const dir = path.join(PENS_DIR, slug);
  const manifest = await readManifest(dir);
  if (!manifest) throw new UserError(`No synced Pen at pens/${slug}. Run \`npm run cp -- pull <id|url>\` first.`);
  return { slug, dir, manifest };
}

async function pickSlug(pen: Pen, wanted?: string): Promise<string> {
  const base = wanted ? slugify(wanted) : slugify(pen.title);
  const free = async (slug: string) => {
    const dir = path.join(PENS_DIR, slug);
    if (!existsSync(dir)) return true;
    const m = await readManifest(dir);
    if (m) return m.id === pen.id;
    return (await readdir(dir)).length === 0;
  };
  if (await free(base)) return base;
  if (wanted) throw new UserError(`pens/${base} already exists and isn't linked to this Pen.`);
  const suffixed = `${base}-${pen.id.replace(/-/g, "").slice(-6).toLowerCase()}`;
  if (await free(suffixed)) return suffixed;
  throw new UserError(`Couldn't find a free folder name for "${pen.title}". Use --as <slug>.`);
}

// ---------------------------------------------------------------------------
// Writing remote files to disk

/**
 * Makes `dir` match `files` exactly (for syncable paths) and returns the manifest entries.
 * Binaries are only downloaded when CodePen's content_hash changed or the local copy is missing,
 * unless the path is in `keepLocal` (files we just uploaded). Pass `local` to reuse a scan of `dir`,
 * and `buildFiles` so binaries of non-public Pens can be read from the build output.
 * A binary that can't be downloaded is skipped with a warning (and left out of the manifest).
 */
async function materialize(
  client: CodePen,
  dir: string,
  files: PenFile[],
  opts: { previous?: Manifest | null; local?: Map<string, LocalFile>; keepLocal?: Set<string>; buildFiles?: PenFile[] } = {},
): Promise<Record<string, ManifestFile>> {
  const { previous, keepLocal = new Set() } = opts;
  const built = new Map((opts.buildFiles ?? []).map((f) => [f.path, f.url]));
  const untracked = new Set<string>(); // local files we couldn't refresh and must not delete
  await mkdir(dir, { recursive: true });
  const local = opts.local ?? (await scanLocal(dir));
  const entries: Record<string, ManifestFile> = {};

  for (const file of files) {
    const rel = file.path.replace(/^\/+/, "");
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw new Error(`Refusing to write outside the Pen folder: ${file.path}`);
    const existing = local.get("/" + rel);
    let hash: string;

    if (file.is_binary || file.content === null) {
      const prev = previous?.files["/" + rel];
      const unchanged = existing && prev && prev.remote_hash === file.content_hash && prev.hash === existing.hash;
      if (existing && (unchanged || keepLocal.has("/" + rel))) {
        hash = existing.hash;
      } else {
        try {
          const data = await client.downloadFile(file, built.get(file.path));
          await writeFileDeep(abs, data);
          hash = sha256(data);
        } catch (err) {
          const kept = existing ? "kept the local copy" : "skipped it";
          console.log(c.yellow(`  ${(err as Error).message} ${kept[0].toUpperCase() + kept.slice(1)}.`));
          if (existing && prev) entries["/" + rel] = prev;
          else if (existing) untracked.add("/" + rel);
          continue;
        }
      }
    } else {
      hash = sha256(file.content);
      if (existing?.hash !== hash) await writeFileDeep(abs, file.content);
    }
    entries["/" + rel] = { id: file.id, hash, remote_hash: file.content_hash, binary: file.is_binary };
  }

  for (const [p, file] of local) {
    if (!entries[p] && !untracked.has(p)) await rm(file.abs);
  }
  await pruneEmptyDirs(dir, dir);
  return entries;
}

async function writeFileDeep(file: string, data: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

async function pruneEmptyDirs(dir: string, root: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name)) {
      await pruneEmptyDirs(path.join(dir, entry.name), root);
    }
  }
  if (dir !== root && (await readdir(dir)).length === 0) await rm(dir, { recursive: true });
}

function newManifest(pen: Pen, files: Record<string, ManifestFile>, versionId: string | null): Manifest {
  return {
    id: pen.id,
    editor: pen.editor,
    title: pen.title,
    url: pen.urls.editor,
    version_id: versionId,
    updated_at: pen.updated_at,
    synced_at: new Date().toISOString(),
    files,
  };
}

function remoteChanged(pen: Pen, manifest: Manifest) {
  return pen.editor === "V2" ? pen.saved_version?.id !== manifest.version_id : pen.updated_at !== manifest.updated_at;
}

// ---------------------------------------------------------------------------
// Commands

export interface ListOptions extends ListOrder {
  page?: number;
  perPage?: number;
  /** Fetch every page instead of one. */
  all?: boolean;
}

export async function list(client: CodePen, filters: PenFilters, opts: ListOptions = {}) {
  const bySlug = await localIndex();
  const sort = opts.sort ?? "updated";
  const order = { sort, direction: opts.direction };

  let pens: Pen[] = [];
  let page: Page<Pen> | null = null;
  if (opts.all) {
    for await (const pen of client.listPens(filters, order)) pens.push(pen);
  } else {
    page = await client.listPensPage(filters, { ...order, page: opts.page, perPage: opts.perPage });
    pens = page.items;
  }

  const offset = page ? (page.page - 1) * (opts.perPage ?? 30) : 0;
  const rows = [["#", "ID", "EDITOR", sort === "created" ? "CREATED" : "UPDATED", ...(sort === "popularity" ? ["POP."] : []), "ACCESS", "TITLE", "LOCAL"].map(c.bold)];
  pens.forEach((pen, i) => {
    rows.push([
      c.dim(String(offset + i + 1)),
      pen.id,
      pen.editor === "V2" ? "2.0" : c.dim("Classic"),
      (sort === "created" ? pen.created_at : pen.updated_at).slice(0, 10),
      ...(sort === "popularity" ? [String(pen.popularity ?? 0)] : []),
      pen.access,
      pen.title || c.dim("(untitled)"),
      bySlug.has(pen.id) ? c.green(`pens/${bySlug.get(pen.id)}`) : "",
    ]);
  });
  if (rows.length === 1) return console.log(page && page.page > 1 ? `No Pens on page ${page.page}.` : "No Pens found.");
  console.log(table(rows));

  if (page) {
    const of = page.lastPage ? ` of ${page.lastPage}` : "";
    const hint = page.hasNext ? ` Next: --page ${page.page + 1}, or --all for every page.` : "";
    console.log(c.dim(`\nPage ${page.page}${of}, sorted by ${sort} ${opts.direction ?? "desc"}.${hint}`));
  }
}

/** Pulls one Pen and returns its folder slug. Pass `index` (from localIndex) when pulling many. */
export async function pull(client: CodePen, ref: string, opts: { as?: string; force?: boolean; index?: Map<string, string> }): Promise<string> {
  let penId = parsePenRef(ref);
  let existingSlug: string | undefined;
  if (!penId) {
    existingSlug = ref;
    penId = (await requireLocalPen(ref)).manifest.id;
  } else {
    existingSlug = (opts.index ?? (await localIndex())).get(penId);
  }

  const pen = await client.getPen(penId);
  const slug = existingSlug && !opts.as ? existingSlug : await pickSlug(pen, opts.as);
  const dir = path.join(PENS_DIR, slug);
  const previous = await readManifest(dir);
  let local: Map<string, LocalFile> | undefined;

  if (previous) {
    local = await scanLocal(dir);
    const diff = diffLocal(previous, local);
    if (!isClean(diff) && !opts.force) {
      printDiff(diff);
      throw new UserError(`pens/${slug} has local changes that pulling would overwrite. Push them, or use --force to discard them.`);
    }
    if (isClean(diff) && !remoteChanged(pen, previous)) {
      console.log(`pens/${slug} is already up to date.`);
      return slug;
    }
  }

  // A version carries its source files and its build's output (needed for non-public binaries) in one request.
  const version = pen.saved_version ? await client.getVersion(pen.saved_version.id) : null;
  const files = version?.files ?? (await client.getPenFiles(pen.id));
  const entries = await materialize(client, dir, files, { previous, local, buildFiles: version?.build.files });
  await writeManifest(dir, newManifest(pen, entries, pen.saved_version?.id ?? null));
  console.log(`${c.green("Pulled")} "${pen.title}" → pens/${slug} ${c.dim(`(${files.length} files${pen.editor === "Classic" ? ", Classic: read-only" : ""})`)}`);
  if (pen.editor === "V2" && pen.saved_version?.build && pen.saved_version.build.status !== "Success") {
    console.log(c.yellow(`  Note: the Pen's latest build on CodePen is ${pen.saved_version.build.status}.`));
  }
  return slug;
}

export async function pullAll(client: CodePen, opts: { force?: boolean; yes?: boolean; filters: PenFilters; order?: ListOrder }) {
  const pens: Pen[] = [];
  for await (const pen of client.listPens(opts.filters, opts.order)) pens.push(pen);
  console.log(`About to pull ${pens.length} Pens, about ${pens.length * 2} API requests (Free plans: 100/hour, 1,000 reads/day).`);
  if (!opts.yes && !(await confirm("Continue?"))) throw new UserError("Cancelled.");
  const index = await localIndex();
  for (const pen of pens) {
    try {
      index.set(pen.id, await pull(client, pen.id, { force: opts.force, index }));
    } catch (err) {
      if (err instanceof CodePenError && err.status === 429) throw err;
      console.log(c.red(`  ${pen.title} (${pen.id}): ${(err as Error).message}`));
    }
  }
}

/**
 * Current remote state for each synced Pen. 2.0 Pens come from the list endpoint (100 per request)
 * when there are several; Classic Pens and single Pens are fetched one by one.
 */
async function remoteHeads(client: CodePen, pens: LocalPen[]): Promise<Map<string, Pen | Error>> {
  const heads = new Map<string, Pen | Error>();
  const v2 = new Set(pens.filter((p) => p.manifest.editor === "V2").map((p) => p.manifest.id));
  if (v2.size > 1) {
    for await (const pen of client.listPens({ editor: "V2" })) {
      if (!v2.has(pen.id)) continue;
      heads.set(pen.id, pen);
      if (heads.size === v2.size) break;
    }
  }
  for (const { manifest } of pens) {
    if (heads.has(manifest.id)) continue;
    try {
      heads.set(manifest.id, await client.getPen(manifest.id));
    } catch (err) {
      if (err instanceof CodePenError && err.status === 429) throw err;
      heads.set(manifest.id, err as Error);
    }
  }
  return heads;
}

export async function status(client: CodePen, slug?: string) {
  const pens = slug ? [await requireLocalPen(slug)] : await localPens();
  if (!pens.length) return console.log("No synced Pens yet. Run `npm run cp -- pull <id|url>`.");
  const heads = await remoteHeads(client, pens);
  for (const { slug, dir, manifest } of pens) {
    const diff = diffLocal(manifest, await scanLocal(dir));
    const head = heads.get(manifest.id)!;
    const remote = head instanceof Error ? null : remoteChanged(head, manifest);
    if (head instanceof Error) console.log(c.red(`  couldn't check CodePen for ${slug}: ${head.message}`));
    const local = !isClean(diff);
    const state =
      local && remote ? c.red("diverged") : local ? c.yellow("local changes") : remote ? c.cyan("remote changes") : c.green("clean");
    console.log(`${c.bold(slug)} ${state}${manifest.editor === "Classic" ? c.dim(" (Classic, read-only)") : ""}`);
    printDiff(diff);
    if (local && remote) console.log(c.dim("  Both sides changed. Pull with --force to take CodePen's copy, or push with --force to overwrite it."));
  }
}

export async function push(client: CodePen, slug: string, opts: { force?: boolean; yes?: boolean }) {
  const { dir, manifest } = await requireLocalPen(slug);
  if (manifest.editor === "Classic") {
    throw new UserError(`"${manifest.title}" is a Classic Pen, which the API can't write to. Run \`npm run cp -- new ${slug}\` to copy it into a new 2.0 Pen.`);
  }

  const local = await scanLocal(dir);
  const diff = diffLocal(manifest, local);
  if (isClean(diff)) return console.log(`pens/${slug}: nothing to push.`);

  const pen = await client.getPen(manifest.id);
  const head = pen.saved_version?.id;
  if (head !== manifest.version_id && !opts.force) {
    printDiff(diff);
    throw new UserError(`The Pen changed on CodePen since your last sync, so both sides have changed. Run \`npm run cp -- status ${slug}\`, then pull --force or push --force.`);
  }

  printDiff(diff);
  if (!opts.yes) {
    console.log(c.yellow("Saving through the API switches anyone with this Pen open in the CodePen editor to read-only."));
    if (!(await confirm(`Push ${countChanges(diff)} change(s) to "${manifest.title}"?`))) throw new UserError("Cancelled (pass --yes to skip this prompt).");
  }

  const { changes, uploads } = await buildChanges(diff);
  let result;
  try {
    result = await client.writeFiles(manifest.id, changes, { expectedVersionId: opts.force ? head : manifest.version_id ?? undefined, uploads });
  } catch (err) {
    if (err instanceof CodePenError && err.status === 409) {
      throw new UserError("CodePen refused the push because the Pen changed in the meantime (409 CONFLICT). Run `status`, then pull or push --force.");
    }
    throw err;
  }
  console.log(c.dim(`  saved version ${result.version.id}`));
  await finishWrite(client, dir, result.pen, result.build, { previous: manifest, local, keepLocal: new Set(uploads.map((u) => u.path)) });
}

export async function create(client: CodePen, target: string, opts: { title?: string; access?: string; yes?: boolean }) {
  const dir = existsSync(path.join(PENS_DIR, target)) ? path.join(PENS_DIR, target) : path.resolve(target);
  if (!existsSync(dir)) throw new UserError(`No folder at pens/${target} or ${target}.`);
  const existing = await readManifest(dir);
  if (existing?.editor === "V2") throw new UserError(`This folder is already linked to a 2.0 Pen (${existing.url}). Use push.`);

  const local = await scanLocal(dir);
  if (!local.size) throw new UserError("The folder has no files to upload.");
  const title = opts.title ?? existing?.title ?? path.basename(dir);
  console.log(`Creating a new 2.0 Pen "${title}" from ${path.relative(ROOT, dir) || dir} (${local.size} files).`);
  console.log(c.yellow("This uses one of your daily Pen creates (Free: 3/day)."));
  if (!opts.yes && !(await confirm("Continue?"))) throw new UserError("Cancelled.");

  const { changes, uploads } = await buildChanges({ added: [...local.values()], modified: [], deleted: [] });
  const pen = await client.createPen({ title, access: opts.access, files: changes }, uploads);
  console.log(`${c.green("Created")} ${pen.urls.editor}`);

  // A folder outside pens/ is left alone; the saved Pen is pulled into pens/<slug> instead.
  const inPens = path.dirname(dir) === PENS_DIR;
  const finalDir = inPens ? dir : path.join(PENS_DIR, await pickSlug(pen));
  if (!pen.build) throw new Error("CodePen didn't return a build for the new Pen.");
  await finishWrite(client, finalDir, pen, pen.build, inPens ? { local, keepLocal: new Set(uploads.map((u) => u.path)) } : {});
  console.log(`Linked to pens/${path.basename(finalDir)}.`);
}

/** Waits for the build, re-reads the saved files (the compiler may have patched them) and updates the manifest. */
async function finishWrite(client: CodePen, dir: string, pen: Pen, build: Build, opts: Parameters<typeof materialize>[3]) {
  const final = await client.settle(build);
  const versionId = final.version_id ?? final.id;
  const version = await client.getVersion(versionId);
  const entries = await materialize(client, dir, version.files ?? [], { ...opts, buildFiles: version.build.files });
  await writeManifest(dir, newManifest({ ...pen, updated_at: version.created_at }, entries, versionId));
  printBuild(final);
}

async function buildChanges(diff: LocalDiff): Promise<{ changes: FileChange[]; uploads: Upload[] }> {
  const changes: FileChange[] = [];
  const uploads: Upload[] = [];
  const files: (LocalDiff["added"][number] & { id?: string })[] = [...diff.added, ...diff.modified];
  for (const f of files) {
    const data = new Uint8Array(await readFile(f.abs));
    if (looksBinary(data)) {
      uploads.push({ path: f.path, data });
      continue;
    }
    const content = new TextDecoder().decode(data);
    changes.push(f.id ? { id: f.id, content } : { path: f.path, content });
  }
  for (const f of diff.deleted) changes.push({ id: f.id, delete: true });
  return { changes, uploads };
}

// ---------------------------------------------------------------------------
// Output

const countChanges = (d: LocalDiff) => d.added.length + d.modified.length + d.deleted.length;

function printDiff(diff: LocalDiff) {
  for (const f of diff.added) console.log(c.green(`  + ${f.path}`));
  for (const f of diff.modified) console.log(c.yellow(`  ~ ${f.path}`));
  for (const f of diff.deleted) console.log(c.red(`  - ${f.path}`));
}

function printBuild(build: Build) {
  for (const p of build.applied_patches ?? []) console.log(c.cyan(`  CodePen ${p.type}d ${p.path} (synced locally)`));
  for (const d of build.diagnostics ?? []) {
    const where = d.path ? `${d.path}${d.range?.start ? `:${d.range.start.line}:${d.range.start.column}` : ""} ` : "";
    const color = d.type === "Error" ? c.red : d.type === "Warning" ? c.yellow : c.dim;
    console.log(color(`  ${d.type.toLowerCase()}: ${where}${d.message}`));
  }
  if (build.status === "Success") return console.log(c.green("Pushed. Build succeeded."));
  process.exitCode = 1; // files are saved, but scripts should still see the build didn't succeed
  if (build.status === "Failed") console.log(c.red("Pushed, but the build failed. Your files are saved on CodePen; fix the errors above and push again."));
  else {
    console.log(c.red("Pushed, but CodePen needs more changes before it can build:"));
    for (const p of build.patches ?? []) console.log(c.red(`  ${p.type} ${p.path}`));
  }
}
