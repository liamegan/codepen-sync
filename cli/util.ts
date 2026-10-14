import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PENS_DIR = path.resolve(process.env.CODEPEN_SYNC_PENS_DIR ?? path.join(ROOT, "pens"));

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "untitled";
}

/**
 * Accepts a 2.0 cpid, a Classic hashid, or any codepen.io Pen URL and returns the Pen id.
 * Returns null when the input doesn't look like a Pen reference (e.g. a local slug).
 */
export function parsePenRef(input: string): string | null {
  const ref = input.trim();
  if (/^https?:\/\//i.test(ref)) {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    // 2.0 editor: /editor/<user>/pen/<penId>[/<versionId>]
    // Classic:    /<user>/pen|full|details|debug|embed/<hashid>
    const i = parts.findIndex((p) => ["pen", "full", "details", "debug", "embed", "live"].includes(p));
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return null;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref.toLowerCase();
  // Classic hashids are short mixed-case alphanumerics; slugs are lowercase with dashes.
  if (/^[A-Za-z0-9]{5,10}$/.test(ref) && /[A-Z]/.test(ref)) return ref;
  return null;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  cyan: paint(36),
};

export class UserError extends Error {}

export function table(rows: string[][]): string {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, strip(cell).length)));
  return rows
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i] - strip(cell).length))).join("  "))
    .join("\n");
}
