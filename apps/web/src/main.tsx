import "@voxeltoy/sdk/style.css";
import "./pwa";
import "./update-notice.css";

import { render } from "solid-js/web";

import App from "./app";

// a headset has no console to read: in dev its errors and WebXR support go to apps/web/logs/remote.log
if (import.meta.env.DEV) await import("../dev/remote-log").then((m) => m.startRemoteLog());

// an emulated headset for working on the headset view at a desk (dev only, opt in with ?xr=emulate)
if (import.meta.env.DEV && new URLSearchParams(location.search).get("xr") === "emulate") {
  await import("../dev/xr-emulator").then((m) => m.installXREmulator());
}

render(() => <App />, document.getElementById("app") as HTMLElement);
