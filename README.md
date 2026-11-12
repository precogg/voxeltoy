# Voxeltoy

A minimal voxel editor for the browser, desktop and phone.

- **Tools:** select, move, add, erase, paint, fill, pick color, orbit
- **Selection:** select with any brush (voxel, box, face, shape) or by color, in replace / add / subtract /
  intersect modes; grow, shrink, invert, connected; move, rotate, flip, duplicate, copy / paste and delete,
  previewed until applied as one undo step ([how it works](docs/selection.md))
- **Brushes:** single voxel, box (drag a rectangle), face (a whole connected face, Qubicle-style)
- **Mirror** on X / Y / Z, **slices** along any axis (with "only this slice" for 2D-style editing)
- **Layers:** show/hide, lock, rename, reorder, duplicate, merge, flip, rotate
- **Palettes:** built-ins (Endesga 32, PICO-8, Sweetie 16); import GIMP `.gpl`, `.hex`, JASC/RIFF `.pal`,
  Paint.NET `.txt`, Photoshop `.act` / `.ase` and images; export `.gpl`, `.hex`, `.pal`, `.png`
- **Files:** `.voxeltoy` documents (`.moxel` still opens), MagicaVoxel `.vox` import/export, `.glb` and transparent `.png` export,
  drag-and-drop to open, local autosave
- Full undo/redo
- **Sharing:** view-only snapshot links anyone can open or copy, and (behind a flag for now) live sessions
  to edit a model together, with per-person undo ([design](docs/collaboration.md))

## Develop

```sh
pnpm install
pnpm dev         # http://localhost:4321, with the sharing API in Wrangler on :8787
pnpm test
```

## Deploy

Voxeltoy runs on Cloudflare Workers Static Assets at https://moxel.precogg.com.
The Worker script name is still `moxel`.
Use Node.js 22.18 or later to run the `cf` CLI (currently in beta).

```sh
pnpm install
npx cf auth login  # cf uses a separate login from Wrangler
# optional: put CLOUDFLARE_ACCOUNT_ID in apps/worker/.env (gitignored) for a non-interactive deploy
pnpm deploy        # builds the mesher and app, then deploys
```

The account id is `CLOUDFLARE_ACCOUNT_ID`, from the environment or from `apps/worker/.env`.
`cf` reads that variable itself, and `apps/worker/cloudflare.config.ts` passes it through.
When the variable is unset, `cf` uses the account saved after `cf auth login`, or asks when
more than one account is available. Local `pnpm dev` does not need it: Wrangler serves the
sharing API from `apps/worker/wrangler.config.ts`.

`apps/worker/cloudflare.config.ts` sets the Worker name, custom domain, and the sharing API: the Worker in
`apps/worker/` (static assets, plus `/api`), its two Durable Object classes (`Snapshot`, `LiveRoom`, SQLite-backed) and
a rate limit on creating links.
`apps/worker/wrangler.config.ts` points Cloudflare's build tool at the website's `apps/web/dist` directory.
Cloudflare manages the domain's DNS record and TLS certificate.

To check a deployment without uploading it:

```sh
pnpm build && (cd apps/worker && npx cf deploy --dry-run)
```

## Install and offline use

Choose **Menu → Install app**, or use the browser's install option. On iPhone and iPad,
open Voxeltoy in Safari and choose **Share → Add to Home Screen**.

The production build includes a web app manifest, install icons and a service worker generated
by `vite-plugin-pwa`. After one online visit, the editor can open and edit the local draft offline.
Sharing and live rooms still need the network. Updates activate once all Voxeltoy tabs and app
windows close, so editing is never interrupted by an automatic reload.

To test locally, run `pnpm build` then `pnpm preview`. Service workers are disabled in
the development server. Installation requires HTTPS (or localhost); a phone visiting a plain
HTTP LAN address will not get the full PWA experience.

## Scripting

The editor is exposed as `window.editor`:

```js
editor.setVoxel([0, 0, 0], 3)          // palette index 3
editor.applyCells([[1, 0, 0]], "add")  // respects mirror and layer lock
editor.transact("Wall", () => { /* … one undo step … */ })
editor.undo()
```

In browsers with [WebMCP](https://webmachinelearning.github.io/webmcp/), Voxeltoy also registers tools that
let an agent inspect the model and build with voxels, shapes, selections, layers and the palette. Each edit
is one undo step. See `packages/core/src/agent-tools.ts`.

See [AGENTS.md](AGENTS.md) for architecture and design tenets.
