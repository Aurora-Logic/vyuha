import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { splitPrecache } from "./src/lib/offline/precache-split"

/**
 * What is running, stamped into the bundle.
 *
 * The version is the package's, which is the one place a release changes it.
 * The commit and the build time can only come from the build, so the release
 * passes them in; a dev build says "dev" rather than inventing a SHA, because
 * a wrong one sends whoever is debugging to the wrong diff.
 */
const APP_VERSION: string = (() => {
  const raw: unknown = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "./package.json"), "utf8"),
  )
  return typeof raw === "object" && raw !== null && "version" in raw && typeof raw.version === "string"
    ? raw.version
    : "0.0.0"
})()
const APP_COMMIT = process.env.GIT_COMMIT ?? "dev"
const APP_BUILT_AT = process.env.BUILT_AT ?? ""

const SW_SOURCE = path.resolve(import.meta.dirname, "./src/lib/offline/service-worker.js")
const SW_VERSION_TOKEN = "__SW_VERSION__"
const SW_CRITICAL_TOKEN = "__SW_BUILD_CRITICAL__"

/**
 * Serves `src/lib/offline/service-worker.js` at `/sw.js`, with its version
 * stamped in.
 *
 * The version is what makes the app replaceable (technical design §8). It names
 * the cache, and the worker deletes every cache whose name does not match on
 * activate — so a version that a person has to remember to bump is a version
 * that will one day be stale while the cache it names is not, and the app
 * becomes unfixable in exactly the way the requirement warns about. Deriving it
 * from the built output removes the chance to forget.
 *
 * The worker is not part of the application bundle. If it were, a build that
 * failed to compile would take the update mechanism down with it.
 */
/**
 * What the worker must hold for the app to start with nothing but a cache.
 *
 * Derived from the emitted bundle rather than written down, because the names
 * carry a content hash and change on every build - a hand-maintained list
 * would be wrong the first time anybody edited a component, and wrong
 * silently.
 *
 * Critical is the shell/Punch static dependency closure plus styles: without
 * it the document paints an empty `<div id="root">`. Every other emitted
 * asset is cached when its route first asks for it, so installing the worker
 * does not download the complete lazy application.
 */

function serviceWorker(): Plugin {
  const read = (): string => readFileSync(SW_SOURCE, "utf8")

  const render = (
    version: string,
    critical: readonly string[] = [],
  ): string =>
    read()
      .replaceAll(SW_VERSION_TOKEN, version)
      .replaceAll(SW_CRITICAL_TOKEN, JSON.stringify(critical))

  // In development the version is a hash of the worker's own source. Stable
  // across reloads and across dev-server restarts, so nothing is reinstalled
  // for no reason; different the moment the file is edited, so the upgrade
  // path — new worker, new cache, old cache deleted — can be driven in
  // development instead of only being reasoned about.
  const devVersion = (): string =>
    `dev-${createHash("sha256").update(read()).digest("hex").slice(0, 8)}`

  return {
    name: "vyuha:service-worker",

    configureServer(server) {
      server.watcher.add(SW_SOURCE)
      server.middlewares.use((req, res, next) => {
        if (!req.url || new URL(req.url, "http://localhost").pathname !== "/sw.js") {
          next()
          return
        }
        res.setHeader("Content-Type", "text/javascript")
        // The browser must never be handed a cached copy of the worker script
        // itself; that is the one request whose freshness decides whether an
        // update can ever arrive.
        res.setHeader("Cache-Control", "no-store")
        res.setHeader("Service-Worker-Allowed", "/")
        res.end(render(devVersion()))
      })
    },

    generateBundle(_options, bundle) {
      // Hashed over the emitted file names, which already carry a content hash
      // each. Two builds of identical source produce the same version and no
      // pointless reinstall; a single changed byte anywhere changes a chunk
      // name, and so changes this.
      const version = createHash("sha256")
        .update(Object.keys(bundle).sort().join("\n"))
        .digest("hex")
        .slice(0, 12)

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: render(version, splitPrecache(bundle).critical),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  envDir: path.resolve(import.meta.dirname, "../../"),
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_COMMIT__: JSON.stringify(APP_COMMIT),
    __APP_BUILT_AT__: JSON.stringify(APP_BUILT_AT),
  },
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // P-23: React and its router/query cache together across deploys;
        // recharts and per-route icons stay in the lazy route chunks that
        // use them (a manual "charts" chunk was preloaded eagerly, defeating
        // the split, so it is left to automatic splitting).
        //
        // Everything the shell touches is named into a handful of chunks
        // because Rollup's automatic split is per-*module* for anything two
        // lazy routes share: 94 lazy routes all importing Spinner, Tooltip
        // and useControlled produced 149 separate preloaded files. Boot is
        // then bound by request count rather than bytes -- measured cold,
        // 156 requests took 722ms at 20ms of latency and 3475ms at 120ms,
        // for the same 1.19 MB. These rules trade nothing away: every one of
        // those files was already fetched before first paint.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) {
            // Forward slashes are safe to match on: Vite normalises ids.
            if (id.includes("/src/components/ui/") || id.includes("/src/components/shared/")) return "ui"
            if (id.includes("/src/lib/") || id.includes("/src/hooks/")) return "app-lib"
            return undefined
          }
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id) || id.includes("@tanstack")) return "react-vendor"
          // No vendor rule for the UI primitives. One was written here
          // spelled `@base-ui-components`, which is not what the package is
          // called, so it matched nothing; spelled correctly as `@base-ui/`
          // it matches and changes nothing, because Rollup folds a chunk
          // whose only importer is `ui` back into it. Measured both ways:
          // 5 preloaded files and 1.58 MB either side. A rule that cannot
          // move a byte is worse than no rule -- it reads like a decision.
          return undefined
        },
      },
    },
  },
})
