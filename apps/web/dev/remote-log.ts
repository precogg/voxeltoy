// Dev only: what a device that can't show its own console (a headset) reports, sent over the
// dev server's socket and written to apps/web/logs/remote.log on the machine running Vite.
// It reports the page's WebXR support when it starts, then errors and warnings.

export function startRemoteLog() {
  const hot = import.meta.hot;
  if (!hot) return;
  const device = /OculusBrowser|Quest/.test(navigator.userAgent) ? "quest" : /Mobile/.test(navigator.userAgent) ? "phone" : "desktop";
  const send = (level: string, message: string) => hot.send("voxeltoy:log", { device, level, message: message.slice(0, 4000) });

  const text = (args: unknown[]) => args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : safeJson(a))).join(" ");
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send(level, text(args));
    };
  }
  addEventListener("error", (e) => send("exception", e.error?.stack ?? e.message));
  addEventListener("unhandledrejection", (e) => send("rejection", e.reason?.stack ?? String(e.reason)));

  void (async () => {
    const xr = navigator.xr;
    const check = async (mode: XRSessionMode) => {
      try {
        return String(await xr!.isSessionSupported(mode));
      } catch (e) {
        return `threw ${(e as Error).message}`;
      }
    };
    const support = xr ? `immersive-ar ${await check("immersive-ar")}, immersive-vr ${await check("immersive-vr")}` : "no navigator.xr";
    send("info", `loaded ${location.href} | secure ${isSecureContext} | ${support} | ${navigator.userAgent}`);
  })();
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
