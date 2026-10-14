import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodePenError, type Build, type CodePen, type Pen, type PenFile, type Version } from "../cli/api.ts";

const PENS = await mkdtemp(path.join(tmpdir(), "codepen-sync-test-"));
process.env.CODEPEN_SYNC_PENS_DIR = PENS;
const { pull, push, status } = await import("../cli/sync.ts");
const { readManifest } = await import("../cli/manifest.ts");
const { UserError } = await import("../cli/util.ts");

afterAll(() => rm(PENS, { recursive: true, force: true }));
vi.spyOn(console, "log").mockImplementation(() => {});

const PEN_ID = "01a10e01-ac64-7d4c-a9d3-f08a20497a99";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]);

const file = (id: string, p: string, content: string | null, hash = id): PenFile => ({
  id, path: p, name: path.basename(p), content_hash: hash, is_binary: content === null, content,
  url: `https://${PEN_ID}.codepenusercontent.com${p}`,
});

const build = (b: Partial<Build>): Build => ({
  id: "v1", status: "Success", rounds: 1, diagnostics: [], errors: [], applied_patches: [], patches: [],
  version_id: "v1", next_id: null, previous_id: null, ...b,
});

const pen = (versionId: string, extra: Partial<Pen> = {}): Pen => ({
  id: PEN_ID, title: "Manifold Mandala", description: "", tags: [], access: "Public", editor: "V2",
  created_at: "2026-10-01T00:00:00Z", updated_at: `2026-10-0${versionId.slice(1)}T00:00:00Z`,
  urls: { editor: `https://codepen.io/editor/me/pen/${PEN_ID}`, preview: null },
  saved_version: { id: versionId, pen_id: PEN_ID, created_at: "", preview_url: "", build: build({ id: versionId }) },
  deployment: null, ...extra,
});

const V1_FILES = [
  file("f-index", "/index.html", "<script type=module src=/src/main.ts></script>"),
  file("f-main", "/src/main.ts", "console.log(1)"),
  file("f-png", "/screenshot.png", null, "png-hash"),
];

function fakeClient(head: { pen: Pen; files: PenFile[] }) {
  const client = {
    getPen: vi.fn(async () => head.pen),
    getPenFiles: vi.fn(async () => head.files),
    downloadFile: vi.fn(async () => PNG),
    writeFiles: vi.fn(),
    settle: vi.fn(async (b: Build) => b),
    getVersion: vi.fn(async (id: string): Promise<Version> => ({
      id, pen_id: PEN_ID, created_at: "", preview_url: "", files: head.files,
      build: { ...build({ id }), files: head.files.filter((f) => f.is_binary).map((f) => ({ ...f, url: `https://pv-x.codepen.dev${f.path}` })) },
    })),
    listPens: vi.fn(async function* () {
      yield head.pen;
    }),
  };
  return client as typeof client & CodePen;
}

const dir = path.join(PENS, "manifold-mandala");

describe("pull / status / push", () => {
  beforeEach(() => rm(dir, { recursive: true, force: true }));

  it("pulls text and binary files and writes a manifest", async () => {
    const client = fakeClient({ pen: pen("v1"), files: V1_FILES });
    await pull(client, PEN_ID, {});
    expect(await readFile(path.join(dir, "src/main.ts"), "utf8")).toBe("console.log(1)");
    expect(new Uint8Array(await readFile(path.join(dir, "screenshot.png")))).toEqual(PNG);
    const manifest = await readManifest(dir);
    expect(manifest).toMatchObject({ id: PEN_ID, editor: "V2", version_id: "v1" });
    expect(Object.keys(manifest!.files)).toEqual(["/index.html", "/screenshot.png", "/src/main.ts"]);

    // 2.0 Pens are read through their saved version, which also carries the build output.
    expect(client.getVersion).toHaveBeenCalledWith("v1");
    expect(client.getPenFiles).not.toHaveBeenCalled();
    expect(client.downloadFile).toHaveBeenCalledWith(V1_FILES[2], "https://pv-x.codepen.dev/screenshot.png");

    // Pulling again by slug with no changes is a no-op, and unchanged binaries aren't re-downloaded.
    await pull(client, "manifold-mandala", {});
    expect(client.getVersion).toHaveBeenCalledTimes(1);
  });

  it("pushes local edits and syncs back the compiler's patches", async () => {
    const client = fakeClient({ pen: pen("v1"), files: V1_FILES });
    await pull(client, PEN_ID, {});

    await writeFile(path.join(dir, "src/main.ts"), "console.log(2)");
    await writeFile(path.join(dir, "src/extra.ts"), "export {}");
    await rm(path.join(dir, "index.html"));
    await mkdir(path.join(dir, "node_modules/x"), { recursive: true });
    await writeFile(path.join(dir, "node_modules/x/index.js"), "ignored");

    const v3Files = [
      file("f-main", "/src/main.ts", "console.log(2);\n"), // formatted on save
      file("f-extra", "/src/extra.ts", "export {}"),
      file("f-png", "/screenshot.png", null, "png-hash"),
      file("f-tsconfig", "/tsconfig.json", "{}"),
    ];
    client.writeFiles.mockResolvedValue({
      pen: pen("v2"),
      version: { id: "v2" },
      build: build({ id: "v2", status: "Canceled", next_id: "v3" }),
    });
    client.settle.mockResolvedValue(
      build({ id: "v3", version_id: "v3", applied_patches: [{ type: "create", path: "/tsconfig.json", file_id: null, content: "{}" }] }),
    );
    client.getVersion.mockResolvedValue({ id: "v3", files: v3Files, build: build({ id: "v3" }) } as Version);

    await push(client, "manifold-mandala", { yes: true });

    expect(client.writeFiles).toHaveBeenCalledWith(
      PEN_ID,
      [
        { path: "/src/extra.ts", content: "export {}" },
        { id: "f-main", content: "console.log(2)" },
        { id: "f-index", delete: true },
      ],
      { expectedVersionId: "v1", uploads: [] },
    );
    expect(client.getVersion).toHaveBeenCalledWith("v3");
    expect(await readFile(path.join(dir, "tsconfig.json"), "utf8")).toBe("{}");
    expect(await readFile(path.join(dir, "src/main.ts"), "utf8")).toBe("console.log(2);\n");
    expect(existsSync(path.join(dir, "index.html"))).toBe(false);
    expect(existsSync(path.join(dir, "node_modules/x/index.js"))).toBe(true);
    expect((await readManifest(dir))!.version_id).toBe("v3");
  });

  it("uploads binary files as multipart parts", async () => {
    const client = fakeClient({ pen: pen("v1"), files: V1_FILES });
    await pull(client, PEN_ID, {});
    await writeFile(path.join(dir, "logo.png"), PNG);
    client.writeFiles.mockRejectedValue(new Error("stop"));
    await expect(push(client, "manifold-mandala", { yes: true })).rejects.toThrow("stop");
    expect(client.writeFiles.mock.calls[0][1]).toEqual([]);
    expect(client.writeFiles.mock.calls[0][2].uploads).toEqual([{ path: "/logo.png", data: PNG }]);
  });

  it("refuses to push when CodePen changed too, unless forced", async () => {
    const head = { pen: pen("v1"), files: V1_FILES };
    const client = fakeClient(head);
    await pull(client, PEN_ID, {});
    await writeFile(path.join(dir, "src/main.ts"), "local edit");
    head.pen = pen("v5");

    await expect(push(client, "manifold-mandala", { yes: true })).rejects.toBeInstanceOf(UserError);
    expect(client.writeFiles).not.toHaveBeenCalled();
    await expect(pull(client, "manifold-mandala", {})).rejects.toThrow(/local changes/);

    client.writeFiles.mockRejectedValue(new Error("stop"));
    await expect(push(client, "manifold-mandala", { yes: true, force: true })).rejects.toThrow("stop");
    expect(client.writeFiles.mock.calls[0][2].expectedVersionId).toBe("v5");

    await status(client, "manifold-mandala");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("diverged"));
  });

  it("turns a 409 into a clear message", async () => {
    const client = fakeClient({ pen: pen("v1"), files: V1_FILES });
    await pull(client, PEN_ID, {});
    await writeFile(path.join(dir, "src/main.ts"), "local edit");
    client.writeFiles.mockRejectedValue(new CodePenError("head moved", 409, "CONFLICT", null));
    await expect(push(client, "manifold-mandala", { yes: true })).rejects.toThrow(/409 CONFLICT/);
  });

  it("checks several 2.0 Pens with one list request instead of one request each", async () => {
    const head = { pen: pen("v1"), files: V1_FILES };
    const client = fakeClient(head);
    await pull(client, PEN_ID, {});
    // A second synced 2.0 Pen, as a copy of the first folder's manifest with another id.
    const other = path.join(PENS, "other-pen");
    await mkdir(other, { recursive: true });
    const manifest = (await readManifest(dir))!;
    await writeFile(path.join(other, ".codepen-sync.json"), JSON.stringify({ ...manifest, id: "other-id", files: {} }));
    const otherPen = { ...pen("v7"), id: "other-id" };
    client.listPens.mockImplementation(async function* () {
      yield head.pen;
      yield otherPen;
    });
    client.getPen.mockClear();

    await status(client);
    expect(client.listPens).toHaveBeenCalledWith({ editor: "V2" });
    expect(client.getPen).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("other-pen remote changes"));
    await rm(other, { recursive: true });
  });

  it("skips a binary it can't download instead of failing the pull", async () => {
    const client = fakeClient({ pen: pen("v1"), files: V1_FILES });
    client.downloadFile.mockRejectedValue(new Error("Couldn't download /screenshot.png (HTTP redirect)."));
    await pull(client, PEN_ID, {});
    expect(await readFile(path.join(dir, "src/main.ts"), "utf8")).toBe("console.log(1)");
    expect(existsSync(path.join(dir, "screenshot.png"))).toBe(false);
    expect(Object.keys((await readManifest(dir))!.files)).toEqual(["/index.html", "/src/main.ts"]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Couldn't download /screenshot.png"));
  });

  it("pulls Classic Pens read-only", async () => {
    const classic = pen("v1", { id: "EaNWMVY", editor: "Classic", title: "CSS 3D camera", saved_version: null });
    const client = fakeClient({ pen: classic, files: [file("a", "/index.html", "<p>hi</p>"), file("b", "/style.scss", "p{}")] });
    await pull(client, "https://codepen.io/me/pen/EaNWMVY", {});
    const classicDir = path.join(PENS, "css-3d-camera");
    expect(await readFile(path.join(classicDir, "style.scss"), "utf8")).toBe("p{}");
    await writeFile(path.join(classicDir, "style.scss"), "p{color:red}");
    await expect(push(client, "css-3d-camera", { yes: true })).rejects.toThrow(/Classic Pen/);
  });
});
