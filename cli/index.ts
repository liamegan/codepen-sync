import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { CodePenError, SORTS, type ListOrder, type Sort } from "./api.ts";
import { buildPen, dev, previewPen } from "./dev.ts";
import { create, getClient, list, pull, pullAll, push, requireLocalPen, status } from "./sync.ts";
import { UserError, c } from "./util.ts";

const HELP = `codepen-sync: sync CodePen Pens to pens/<slug> and run them with Vite.

Usage: npm run cp -- <command> [options]

  list                     List your Pens, 30 per page, most recently updated first
                             --page <n>, --per-page <n> (max 100), --all
                             --sort updated|created|popularity, --asc / --desc
                             --search <text>, --tag <tag>, --editor V2|Classic
  pull <slug|id|url>       Download a Pen into pens/<slug> (--as <slug>, --force)
                             slug: as shown by list; url: codepen.io editor or pen link
  pull --all               Download every Pen (--yes, --force, plus list filters and sorting)
  status [slug]            Show local and remote changes for one or all Pens
  push <slug>              Upload local changes to the Pen (--yes, --force)
  new <slug|dir>           Create a new 2.0 Pen from a folder or a Classic Pen
                             (--title, --access Public|Private|Protected|Collaborators, --yes)
  dev <slug>               Run the Pen with the Vite dev server (--port)
  build <slug>             Build the Pen into pens/<slug>/dist
  preview <slug>           Serve the built Pen (--port)
  open <slug>              Open the Pen in the CodePen editor

Shortcut: npm run dev <slug>

Options:
  --force   pull: discard local changes. push: overwrite changes made on CodePen.
  --yes     Skip confirmation prompts.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      as: { type: "string" },
      all: { type: "boolean" },
      force: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      title: { type: "string" },
      access: { type: "string" },
      port: { type: "string" },
      search: { type: "string" },
      tag: { type: "string" },
      editor: { type: "string" },
      sort: { type: "string" },
      direction: { type: "string" },
      asc: { type: "boolean" },
      desc: { type: "boolean" },
      page: { type: "string", short: "p" },
      "per-page": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  const port = values.port ? Number(values.port) : undefined;
  const filters = { search_term: values.search, tags: values.tag, editor: values.editor };
  const order = parseOrder(values);
  const need = (what: string) => {
    if (!arg) throw new UserError(`Missing ${what}. Run \`npm run cp -- --help\`.`);
    return arg;
  };

  if (!command || values.help) return console.log(HELP);

  switch (command) {
    case "list":
      return list(getClient(), filters, {
        ...order,
        all: values.all,
        page: positiveInt(values.page, "--page"),
        perPage: positiveInt(values["per-page"], "--per-page", 100),
      });
    case "pull":
      if (values.all) return pullAll(getClient(), { force: values.force, yes: values.yes, filters, order });
      return pull(getClient(), need("a Pen id, URL or slug"), { as: values.as, force: values.force });
    case "status":
      return status(getClient(), arg);
    case "push":
      return push(getClient(), need("a slug"), { force: values.force, yes: values.yes });
    case "new":
      return create(getClient(), need("a slug or folder"), { title: values.title, access: values.access, yes: values.yes });
    case "dev":
      return dev(need("a slug"), port);
    case "build":
      return buildPen(need("a slug"));
    case "preview":
      return previewPen(need("a slug"), port);
    case "open": {
      const { manifest } = await requireLocalPen(need("a slug"));
      console.log(manifest.url);
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [manifest.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      return;
    }
    default:
      throw new UserError(`Unknown command "${command}". Run \`npm run cp -- --help\`.`);
  }
}

function parseOrder(values: { sort?: string; direction?: string; asc?: boolean; desc?: boolean }): ListOrder {
  const sort = values.sort?.toLowerCase();
  if (sort && !(SORTS as readonly string[]).includes(sort)) throw new UserError(`--sort must be one of ${SORTS.join(", ")}.`);
  if (values.asc && values.desc) throw new UserError("Pass only one of --asc and --desc.");
  const direction = values.asc ? "asc" : values.desc ? "desc" : values.direction?.toLowerCase();
  if (direction && direction !== "asc" && direction !== "desc") throw new UserError("--direction must be asc or desc.");
  return { sort: sort as Sort | undefined, direction: direction as ListOrder["direction"] };
}

function positiveInt(value: string | undefined, flag: string, max = Infinity): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UserError(`${flag} must be a whole number from 1${max < Infinity ? ` to ${max}` : " up"}.`);
  return n;
}

main().catch((err) => {
  if (err instanceof UserError) console.error(c.red(err.message));
  else if (err instanceof CodePenError) console.error(c.red(`CodePen API error ${err.status} ${err.code}: ${err.message}`));
  else console.error(err);
  process.exitCode = 1;
});
