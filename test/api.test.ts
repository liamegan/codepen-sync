import { describe, expect, it, vi } from "vitest";
import { CodePen, CodePenError, nextLink, type Build } from "../cli/api.ts";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const build = (b: Partial<Build>): Build => ({
  id: "v1", status: "Success", rounds: 1, diagnostics: [], errors: [], applied_patches: [], patches: [],
  version_id: "v1", next_id: null, previous_id: null, ...b,
});

describe("CodePen client", () => {
  it("sends the key as a bearer token", async () => {
    const fetch = vi.fn(async () => json({ id: "p" }));
    await new CodePen({ key: "cp_user_test", fetch }).getPen("p");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.codepen.io/v2/pens/p");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cp_user_test");
  });

  it("follows Link rel=next when paginating", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json([{ id: "a" }, { id: "b" }], { headers: { link: '<https://api.codepen.io/v2/pens?page=2>; rel="next", <https://api.codepen.io/v2/pens?page=2>; rel="last"' } }))
      .mockResolvedValueOnce(json([{ id: "c" }], { headers: { link: '<https://api.codepen.io/v2/pens?page=1>; rel="prev"' } }));
    const ids = [];
    for await (const pen of new CodePen({ key: "k", fetch }).listPens()) ids.push(pen.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(fetch.mock.calls[1][0]).toBe("https://api.codepen.io/v2/pens?page=2");
  });

  it("settles builds, following next_id", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(build({ id: "v1", status: "Canceled", next_id: "v2" })))
      .mockResolvedValueOnce(json(build({ id: "v2", status: "Running", version_id: null })))
      .mockResolvedValueOnce(json(build({ id: "v2", status: "Success", version_id: "v2", previous_id: "v1" })));
    const client = new CodePen({ key: "k", fetch, sleep: async () => {} });
    const final = await client.settle(build({ id: "v1", status: "Queued" }));
    expect(final).toMatchObject({ id: "v2", status: "Success" });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://api.codepen.io/v2/builds/v1",
      "https://api.codepen.io/v2/builds/v2",
      "https://api.codepen.io/v2/builds/v2",
    ]);
  });

  it("doesn't poll builds that are already settled", async () => {
    const fetch = vi.fn();
    const client = new CodePen({ key: "k", fetch, sleep: async () => {} });
    for (const b of [build({ status: "Success" }), build({ status: "Failed" }), build({ status: "Canceled" })]) await client.settle(b);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps error bodies to CodePenError", async () => {
    const fetch = vi.fn(async () => json({ message: "head moved", code: "CONFLICT" }, { status: 409 }));
    const err = await new CodePen({ key: "k", fetch }).writeFiles("p", [], { expectedVersionId: "v1" }).catch((e) => e);
    expect(err).toBeInstanceOf(CodePenError);
    expect(err).toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("downloads from the build output when a private Pen's raw URL redirects to sign-in", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://codepen.io/cpe/pens/session/transfer" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const file = { id: "f", path: "/a.png", name: "a.png", content_hash: "h", is_binary: true, content: null, url: "https://p.codepenusercontent.com/a.png" };
    const data = await new CodePen({ key: "secret", fetch }).downloadFile(file, "https://pv-x.codepen.dev/a.png");
    expect([...data]).toEqual([1, 2, 3]);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([file.url, "https://pv-x.codepen.dev/a.png"]);
    // Neither request carries the API key.
    for (const [, init] of fetch.mock.calls) expect(JSON.stringify(init ?? {})).not.toContain("secret");
  });

  it("uses multipart for binary uploads", async () => {
    const fetch = vi.fn(async () => json({}));
    await new CodePen({ key: "k", fetch }).writeFiles("p", [{ path: "/a.js", content: "1" }], {
      expectedVersionId: "v1",
      uploads: [{ path: "/img.png", data: new Uint8Array([0, 1, 2]) }],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.codepen.io/v2/pens/p/files?wait=45");
    const form = init.body as FormData;
    expect(JSON.parse(form.get("changes") as string)).toEqual({ files: [{ path: "/a.js", content: "1" }] });
    expect(form.get("expected_version_id")).toBe("v1");
    expect(form.get("/img.png")).toBeInstanceOf(Blob);
  });
});

describe("listPensPage", () => {
  const LINKS = (page: number, last: number) =>
    [page > 1 && `<https://api.codepen.io/v2/pens?page=${page - 1}>; rel="prev"`, page < last && `<https://api.codepen.io/v2/pens?page=${page + 1}>; rel="next"`, `<https://api.codepen.io/v2/pens?page=${last}>; rel="last"`]
      .filter(Boolean)
      .join(", ");

  it("requests one sorted page and reports where it is", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => json([{ id: "a" }], { headers: { link: LINKS(2, 5) } }));
    const page = await new CodePen({ key: "k", fetch }).listPensPage({ editor: "V2" }, { sort: "popularity", direction: "asc", page: 2, perPage: 10 });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ sort: "popularity", direction: "asc", per_page: "10", page: "2", editor: "V2" });
    expect(page).toEqual({ items: [{ id: "a" }], page: 2, lastPage: 5, hasNext: true });
  });

  it("defaults to the first 30, most recently updated", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => json([]));
    const page = await new CodePen({ key: "k", fetch }).listPensPage();
    expect(fetch.mock.calls[0][0]).toBe("https://api.codepen.io/v2/pens?sort=updated&direction=desc&per_page=30");
    expect(page).toMatchObject({ page: 1, lastPage: 1, hasNext: false });
  });

  it("handles the last page and unknown totals", async () => {
    const last = await new CodePen({ key: "k", fetch: vi.fn(async () => json([], { headers: { link: LINKS(5, 5) } })) }).listPensPage({}, { page: 5 });
    expect(last).toMatchObject({ page: 5, lastPage: 5, hasNext: false });
    const unknown = await new CodePen({
      key: "k",
      fetch: vi.fn(async () => json([], { headers: { link: '<https://api.codepen.io/v2/pens?page=4>; rel="next"' } })),
    }).listPensPage({}, { page: 3 });
    expect(unknown).toMatchObject({ page: 3, lastPage: null, hasNext: true });
  });
});

describe("nextLink", () => {
  it("returns null without a next link", () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink('<https://x/?page=1>; rel="prev"')).toBeNull();
  });
});
