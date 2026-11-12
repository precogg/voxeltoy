// Whether this browser can show a headset view, without loading the session.

export type XRMode = "immersive-ar" | "immersive-vr";

/** The immersive mode this browser offers: passthrough when it can, else a virtual room. Null without either. */
export async function xrMode(): Promise<XRMode | null> {
  const xr = typeof navigator !== "undefined" ? navigator.xr : undefined;
  if (!xr) return null;
  try {
    if (await xr.isSessionSupported("immersive-ar")) return "immersive-ar";
    if (await xr.isSessionSupported("immersive-vr")) return "immersive-vr";
  } catch {
    // a browser that blocks XR (a permissions policy) says so by throwing
  }
  return null;
}

/** Call `fn` with the mode now and again whenever a headset comes or goes. Returns a function that stops listening. */
export function watchXRMode(fn: (mode: XRMode | null) => void): () => void {
  const check = () => void xrMode().then(fn);
  check();
  const xr = typeof navigator !== "undefined" ? navigator.xr : undefined;
  xr?.addEventListener("devicechange", check);
  return () => xr?.removeEventListener("devicechange", check);
}
