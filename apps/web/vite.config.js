import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";
import { appendFileSync, mkdirSync } from "node:fs";

/** Dev only: write what devices report (dev/remote-log.ts) to logs/remote.log, for headsets that have no console to read. */
const remoteLog = () => ({
  name: "voxeltoy-remote-log",
  apply: "serve",
  configureServer(server) {
    const dir = new URL("./logs/", import.meta.url);
    mkdirSync(dir, { recursive: true });
    server.ws.on("voxeltoy:log", ({ device, level, message }) => {
      appendFileSync(new URL("remote.log", dir), `${new Date().toISOString()} [${device}] ${level}: ${message}\n`);
    });
  },
});

export default defineConfig({
  plugins: [solidPlugin(), remoteLog(), VitePWA({
    // Updates wait for an explicit Refresh tap; never reload an editor mid-stroke.
    registerType: "prompt",
    manifest: {
      id: "/",
      name: "Voxeltoy",
      short_name: "Voxeltoy",
      description: "A minimal voxel editor. Create, edit and export voxel models.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#f4f5f7",
      background_color: "#f4f5f7",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    workbox: {
      globPatterns: ["**/*.{js,css,html,wasm,svg,png}"],
      navigateFallbackDenylist: [/^\/api(?:\/|$)/],
      // Shared documents and live rooms always use the network, never a cached response.
      runtimeCaching: [],
    },
  })],
  server: {
    port: 4321,
    // reachable from a phone on the same network for touch testing
    host: true,
    // and from a headset over Tailscale: `tailscale serve` gives the dev server an https:// name
    // (WebXR needs a secure origin), e.g. https://<machine>.<tailnet>.ts.net:4321
    allowedHosts: [".ts.net"],
    // the sharing API runs in Wrangler (npm run dev starts both)
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    target: "es2022",
  },
  assetsInclude: ["**/*.wasm"],
});
