# codepen-sync

Pull your CodePen Pens into local folders, run them with [Vite](https://vite.dev), and push your changes back. It uses the [CodePen API v2](https://blog.codepen.io/docs/api/api-v2/).

```
pens/
  manifold-mandala/          ← one folder per Pen
    .codepen-sync.json       ← sync state (Pen id, last synced version, file hashes)
    .codepen/pen.config.json ← CodePen's own config, synced like any other file
    index.html
    package.json
    src/main.js
```

## Setup

Requires Node 22 or later.

```sh
git clone <this repo> my-pens && cd my-pens
npm install
cp .env.example .env    # then paste your key from https://codepen.io/settings/api
```

## Usage

```sh
npm run cp -- list                          # your Pens, 30 per page, newest updates first
npm run cp -- list --sort popularity --page 2 --per-page 50
npm run cp -- pull <id|url>                 # → pens/<slug>
npm run dev <slug>                          # Vite dev server with HMR
npm run cp -- status                        # what changed locally and on CodePen
npm run cp -- push <slug>                   # save local changes to CodePen
```

| Command                          | What it does                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`                           | Lists your Pens one page at a time and marks the ones already pulled. `--page <n>` and `--per-page <n>` (max 100) page through them. `--all` fetches every page. `--sort updated\|created\|popularity` and `--asc`/`--desc` (or `--direction`) set the order, newest updates first by default. `--search <text>`, `--tag <tag>` and `--editor V2\|Classic` filter. |
| `pull <id\|url\|slug>`           | Downloads a Pen. It accepts a 2.0 Pen id, a Classic hashid, an editor URL, a `codepen.io/<user>/pen/<id>` URL, or the slug of a Pen you already pulled (to refresh it). `--as <slug>` picks the folder name.                                                                                                                                                       |
| `pull --all`                     | Pulls every Pen (accepts `list`'s filters and sorting). It asks first, because this costs about 2 requests per Pen.                                                                                                                                                                                                                                                |
| `status [slug]`                  | For each Pen, shows **clean**, **local changes**, **remote changes** or **diverged**, plus the changed files.                                                                                                                                                                                                                                                      |
| `push <slug>`                    | Uploads added, changed and deleted files as one new version, waits for CodePen's build, then writes the saved files back locally (see below).                                                                                                                                                                                                                      |
| `new <slug\|dir>`                | Creates a new 2.0 Pen from a folder, or from a pulled Classic Pen, and links the folder to it. `--title` names it. `--access Private` (or `Protected`, `Collaborators`, all PRO only) keeps it off your public profile.                                                                                                                                                                                                                                                                     |
| `dev`, `build`, `preview <slug>` | Runs Vite on the Pen folder. `build` writes `pens/<slug>/dist`. `--port` sets the port.                                                                                                                                                                                                                                                                            |
| `open <slug>`                    | Opens the Pen in the CodePen editor.                                                                                                                                                                                                                                                                                                                               |

Pass `--yes` to skip confirmation prompts.

### How syncing works

- `.codepen-sync.json` stores the Pen's head version and a hash of every file as of the last sync. `status` compares against it on both sides.
- **Conflicts:** if the Pen changed on CodePen _and_ locally, `push` and `pull` refuse.
  - `pull --force` throws away your local changes.
  - `push --force` overwrites the changes made on CodePen.
- **Pushes are optimistic.** Each push sends `expected_version_id`, so CodePen rejects it with `409 CONFLICT` if someone saved in between.
- **CodePen may edit your files.** Every push is built on CodePen, and the compiler can change what you sent. For example, it can:
  - add a `tsconfig.json` for your first `.ts` file
  - add `type="module"` to a script tag
  - add imported packages to `package.json`
  - format the code

  After each push the tool writes CodePen's saved copy back to disk and lists what changed. Build errors and warnings are printed too. A failed build still saves your files.

- **Never synced:** `node_modules/`, `dist/`, `.DS_Store` and `.codepen-sync.json` itself.

### Running Pens with Vite

- **2.0 Pens** are already shaped like a Vite project (`index.html`, `src/`, `package.json`).
  - On the first `dev` or `build`, the tool runs `npm install` in the Pen folder if the Pen declares packages. It uses `--no-package-lock`, so a lockfile doesn't show up as a new file to push.
  - Every top-level `.html` file is a build entry.
  - A `vite.config.*` file in the Pen folder is used if it exists.
- **Classic Pens** come back from the API as a ready-to-run `index.html`. It already includes the Pen's external CDN scripts and styles, and it links `style.*` and `script.*`.
  - Vite compiles Sass/SCSS. Install `less` or `stylus` at the repo root if you need those.
  - Plain (non-module) local scripts are copied into `dist` on build.

## Caveats

- **Classic Pens are read-only.** The API can't write to them. Use `new <slug>` to copy one into a new 2.0 Pen.
- **Your key only reaches your own Pens.** It can't reach other people's Pens, or Pens you only collaborate on. Personal keys don't reach Team Pens.
- **Pushing locks open editors.** Anyone who has the Pen open in the CodePen editor is switched to read-only. Edits they haven't saved are lost when they refresh.
- **Rate limits:**
  - Free: 100 requests/hour, 1,000 reads/day, and 3 new Pens/day (forks included).
  - PRO: 3,000 requests/hour, 10,000 reads/day, and 50 new Pens/day.
  - Each `status` costs one request per Pen. `pull` costs two, plus one per changed binary file.
  - `list` costs one request per page. `list --all` fetches 100 per request.

## Development

```sh
npm test            # vitest, with mocked API calls
npm run typecheck
```

The CLI lives in `cli/`:

| File          | Contents               |
| ------------- | ---------------------- |
| `api.ts`      | REST client            |
| `manifest.ts` | Sync state and diffing |
| `sync.ts`     | Commands               |
| `dev.ts`      | Vite                   |

Set `CODEPEN_SYNC_PENS_DIR` to use a different pens folder.
