import { bindings, defineConfig, defineWorker, exports } from "cf/config";

// This file is loaded by Node (`cf`), which has no Node types in the worker tsconfig.
declare const process: { env: { CLOUDFLARE_ACCOUNT_ID?: string } };

/** Account for `cf` commands. Unset here means `cf` uses a saved login or asks. */
function cloudflareAccountId(): string | undefined {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return id ? id : undefined;
}

const worker = defineWorker({
  name: "moxel",
  compatibilityDate: "2026-09-30",
  entrypoint: "./index.ts",
  domains: ["moxel.precogg.com"],
  workersDev: false,
  previewUrls: false,
  observability: {
    enabled: true,
  },
  // the app is static; only the sharing API runs code
  assets: { runWorkerFirst: ["/api/*"] },
  env: {
    ASSETS: bindings.assets(),
    SNAPSHOTS: bindings.durableObject({ worker: "moxel", exportName: "Snapshot" }),
    ROOMS: bindings.durableObject({ worker: "moxel", exportName: "LiveRoom" }),
    CREATE_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 10, period: 60 } }),
  },
  exports: {
    Snapshot: exports.durableObject({ storage: "sqlite" }),
    LiveRoom: exports.durableObject({ storage: "sqlite" }),
  },
});

export default defineConfig({
  accountId: cloudflareAccountId(),
  worker,
});
