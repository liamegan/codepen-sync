import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { build, createServer, preview, type InlineConfig, type Plugin } from "vite";
import { requireLocalPen } from "./sync.ts";
import { c } from "./util.ts";

const VITE_CONFIGS = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.mts"];

/** Runs `npm install` in the Pen folder when it declares packages that aren't installed yet. */
function ensureDeps(dir: string) {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath) || existsSync(path.join(dir, "node_modules"))) return;
  let pkg: { dependencies?: object; devDependencies?: object };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }
  if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) return;
  console.log(c.dim("Installing the Pen's packages…"));
  // --no-package-lock keeps a lockfile from showing up as a new file to push.
  const res = spawnSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error("npm install failed in the Pen folder.");
}

async function htmlEntries(dir: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    if (name.endsWith(".html")) entries[name.replace(/\.html$/, "")] = path.join(dir, name);
  }
  return entries;
}

/**
 * Vite only bundles `<script type="module">`. Classic Pens (and some 2.0 Pens) load plain
 * `<script src="./script.js">`, which Vite leaves in the HTML but doesn't copy to dist.
 */
export function copyClassicScripts(dir: string): Plugin {
  return {
    name: "codepen-sync:classic-scripts",
    apply: "build",
    async generateBundle() {
      const seen = new Set<string>();
      for (const html of Object.values(await htmlEntries(dir))) {
        const source = await readFile(html, "utf8");
        for (const src of classicScriptSources(source)) {
          const file = path.resolve(path.dirname(html), src);
          const rel = path.relative(dir, file);
          if (seen.has(rel) || rel.startsWith("..") || !existsSync(file)) continue;
          seen.add(rel);
          this.emitFile({ type: "asset", fileName: rel.split(path.sep).join("/"), source: await readFile(file) });
        }
      }
    },
  };
}

/** Local `src`s of `<script>` tags that aren't ES modules. */
export function classicScriptSources(html: string): string[] {
  const out: string[] = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (/\btype\s*=\s*["']?module/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src && !/^(?:[a-z]+:)?\/\//i.test(src) && !src.startsWith("data:")) out.push(src.replace(/^\//, "./"));
  }
  return out;
}

async function viteConfig(slug: string, mode: "dev" | "build" | "preview", port?: number): Promise<InlineConfig> {
  const { dir, manifest } = await requireLocalPen(slug);
  if (mode !== "preview") ensureDeps(dir);
  const hasOwnConfig = VITE_CONFIGS.some((f) => existsSync(path.join(dir, f)));
  if (manifest.editor === "Classic") console.log(c.dim("Classic Pen: running CodePen's generated index.html."));
  return {
    root: dir,
    configFile: hasOwnConfig ? undefined : false,
    base: "./",
    logLevel: "info",
    plugins: [copyClassicScripts(dir)],
    server: { open: true, port },
    preview: { open: true, port },
    build: {
      outDir: path.join(dir, "dist"),
      emptyOutDir: true,
      rolldownOptions: { input: await htmlEntries(dir) },
    },
  };
}

export async function dev(slug: string, port?: number) {
  const server = await createServer(await viteConfig(slug, "dev", port));
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}

export async function buildPen(slug: string) {
  await build(await viteConfig(slug, "build"));
}

export async function previewPen(slug: string, port?: number) {
  const server = await preview(await viteConfig(slug, "preview", port));
  server.printUrls();
}
