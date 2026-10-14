// Minimal client for the CodePen REST API v2: https://blog.codepen.io/docs/api/api-v2/

export const API_BASE = "https://api.codepen.io/v2";

export type Editor = "V2" | "Classic";
export type BuildStatus = "Queued" | "Running" | "Success" | "Failed" | "Canceled";

export interface PenFile {
  id: string;
  path: string;
  name: string;
  content_hash: string;
  is_binary: boolean;
  content: string | null;
  url: string | null;
}

export interface Diagnostic {
  type: "Error" | "Warning" | "Information" | "Hint";
  scope: string;
  message: string;
  path: string | null;
  range: { start: { line: number; column: number } | null } | null;
}

export interface Patch {
  type: "create" | "update" | "delete";
  path: string;
  file_id: string | null;
  content: string | null;
}

export interface Build {
  id: string;
  status: BuildStatus;
  /** Compiled output; present only on a successful build fetched individually. */
  files?: PenFile[];
  rounds: number;
  diagnostics: Diagnostic[];
  errors: Diagnostic[];
  applied_patches: Patch[];
  patches: Patch[];
  version_id: string | null;
  next_id: string | null;
  previous_id: string | null;
}

export interface Version {
  id: string;
  pen_id: string;
  created_at: string;
  build: Build;
  preview_url: string;
  files?: PenFile[];
}

export interface Pen {
  id: string;
  title: string;
  description: string;
  tags: string[];
  access: string;
  popularity?: number;
  editor: Editor;
  created_at: string;
  updated_at: string;
  urls: { editor: string; preview: string | null };
  saved_version: Version | null;
  deployment: { url: string } | null;
  build?: Build;
}

export interface WriteResult {
  pen: Pen;
  version: Version;
  build: Build;
}

/** A change for PUT /pens/:id/files. Binary uploads are passed separately. */
export type FileChange =
  | { path: string; content: string }
  | { id: string; content: string }
  | { id: string; path: string; content?: string }
  | { path: string; delete: true }
  | { id: string; delete: true };

export interface Upload {
  path: string;
  data: Uint8Array<ArrayBuffer>;
}

export class CodePenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  key: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  onPoll?: (build: Build) => void;
}

const SETTLED = (b: Build) => b.status === "Success" || b.status === "Failed" || (b.status === "Canceled" && !b.next_id);

export class CodePen {
  private fetch: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private pollIntervalMs: number;

  constructor(private opts: ClientOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = opts.pollIntervalMs ?? 2500;
  }

  async raw(method: string, pathOrUrl: string, init: { json?: unknown; form?: FormData } = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API_BASE + pathOrUrl;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.key}`, Accept: "application/json" };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }
    const res = await this.fetch(url, { method, headers, body });
    if (!res.ok) throw await toError(res);
    return res;
  }

  async request<T>(method: string, path: string, init: { json?: unknown; form?: FormData } = {}): Promise<T> {
    const res = await this.raw(method, path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Follows the Link header's rel="next" until exhausted. */
  async *paginate<T>(path: string): AsyncGenerator<T> {
    let next: string | null = path;
    while (next) {
      const res = await this.raw("GET", next);
      for (const item of (await res.json()) as T[]) yield item;
      next = nextLink(res.headers.get("link"));
    }
  }

  /** Every Pen matching the filters, following pagination. */
  listPens(filters: PenFilters = {}, order: ListOrder = {}) {
    return this.paginate<Pen>(`/pens?${penQuery(filters, { ...order, perPage: 100 })}`);
  }

  /** One page of Pens, plus enough paging info to say where it sits. */
  async listPensPage(filters: PenFilters = {}, order: ListOrder & { page?: number; perPage?: number } = {}): Promise<Page<Pen>> {
    const page = order.page ?? 1;
    const res = await this.raw("GET", `/pens?${penQuery(filters, { ...order, page })}`);
    const items = (await res.json()) as Pen[];
    const links = parseLinks(res.headers.get("link"));
    // On the last page CodePen may omit rel="last"; without next there are no more pages either way.
    const last = links.last ? Number(new URL(links.last).searchParams.get("page")) || null : null;
    return { items, page, lastPage: links.next ? last : Math.max(page, last ?? page), hasNext: !!links.next };
  }

  getPen(id: string) {
    return this.request<Pen>("GET", `/pens/${encodeURIComponent(id)}`);
  }

  getPenFiles(id: string) {
    return this.request<PenFile[]>("GET", `/pens/${encodeURIComponent(id)}/files`);
  }

  getVersion(id: string) {
    return this.request<Version>("GET", `/versions/${encodeURIComponent(id)}`);
  }

  getBuild(id: string) {
    return this.request<Build>("GET", `/builds/${encodeURIComponent(id)}`);
  }

  /**
   * Downloads a file's bytes. A non-public Pen's raw `url` redirects to a browser sign-in that the
   * API key can't pass, so `fallbackUrl` (the same path in the build output) is tried next.
   * The key is never sent to these hosts.
   */
  async downloadFile(file: PenFile, fallbackUrl?: string | null): Promise<Uint8Array> {
    const statuses: string[] = [];
    for (const url of [file.url, fallbackUrl]) {
      if (!url) continue;
      const res = await this.fetch(url, { redirect: "manual" });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      statuses.push(`HTTP ${res.status || "redirect"}`);
    }
    throw new Error(`Couldn't download ${file.path} (${statuses.join(", ") || "no URL"}).`);
  }

  createPen(body: { title?: string; description?: string; tags?: string[]; access?: string; files: FileChange[] }, uploads: Upload[] = []) {
    const payload = { ...body, wait: 45 };
    if (!uploads.length) return this.request<Pen>("POST", "/pens", { json: payload });
    const form = new FormData();
    form.set("pen", JSON.stringify(payload));
    for (const u of uploads) form.append(u.path, new Blob([u.data]), basename(u.path));
    return this.request<Pen>("POST", "/pens?wait=45", { form });
  }

  writeFiles(penId: string, changes: FileChange[], opts: { expectedVersionId?: string; uploads?: Upload[] } = {}) {
    const path = `/pens/${encodeURIComponent(penId)}/files`;
    const uploads = opts.uploads ?? [];
    if (!uploads.length) {
      return this.request<WriteResult>("PUT", path, {
        json: { files: changes, expected_version_id: opts.expectedVersionId, wait: 45 },
      });
    }
    const form = new FormData();
    form.set("changes", JSON.stringify({ files: changes }));
    if (opts.expectedVersionId) form.set("expected_version_id", opts.expectedVersionId);
    for (const u of uploads) form.append(u.path, new Blob([u.data]), basename(u.path));
    return this.request<WriteResult>("PUT", `${path}?wait=45`, { form });
  }

  /** Polls until the build settles, following next_id while the API applies compiler patches. */
  async settle(build: Build): Promise<Build> {
    let current = build;
    while (!SETTLED(current)) {
      await this.sleep(this.pollIntervalMs);
      current = await this.getBuild(current.status === "Canceled" && current.next_id ? current.next_id : current.id);
      this.opts.onPoll?.(current);
    }
    return current;
  }
}

export const SORTS = ["created", "updated", "popularity"] as const;
export type Sort = (typeof SORTS)[number];
export type PenFilters = { search_term?: string; tags?: string; editor?: string; access?: string };
export type ListOrder = { sort?: Sort; direction?: "asc" | "desc" };
export interface Page<T> {
  items: T[];
  page: number;
  /** null when CodePen didn't say how many pages there are. */
  lastPage: number | null;
  hasNext: boolean;
}

function penQuery(filters: PenFilters, opts: ListOrder & { page?: number; perPage?: number }) {
  const q = new URLSearchParams({
    sort: opts.sort ?? "updated",
    direction: opts.direction ?? "desc",
    per_page: String(opts.perPage ?? 30),
  });
  if (opts.page && opts.page > 1) q.set("page", String(opts.page));
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return q;
}

/** Parses a GitHub-style Link header into { next, prev, first, last } URLs. */
export function parseLinks(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  for (const part of header?.split(",") ?? []) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?([a-z]+)"?/);
    if (m) links[m[2]] = m[1];
  }
  return links;
}

export function nextLink(header: string | null): string | null {
  return parseLinks(header).next ?? null;
}

async function toError(res: Response): Promise<CodePenError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  const code = body?.code ?? `HTTP_${res.status}`;
  let message = body?.message ?? res.statusText;
  if (res.status === 429) message = `Rate limited by CodePen (${message}). Free plans allow 100 requests/hour; try again later.`;
  if (res.status === 401) message = `CodePen rejected the API key (${message}). Check CODEPEN_API_KEY in .env.`;
  return new CodePenError(message, res.status, code, body);
}

function basename(p: string) {
  return p.split("/").pop() || p;
}
