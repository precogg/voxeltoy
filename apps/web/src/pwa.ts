import { createSignal } from "solid-js";
import { registerSW } from "virtual:pwa-register";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: InstallPromptEvent | undefined;
const standalone = window.matchMedia("(display-mode: standalone)");
const [installed, setInstalled] = createSignal(
  standalone.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
);
export { installed };

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as InstallPromptEvent;
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  setInstalled(true);
});
standalone.addEventListener("change", (event) => setInstalled(event.matches));

/** Must be called directly from a tap so the browser permits its native prompt. */
export async function installApp(showInstructions: () => void): Promise<void> {
  if (!installPrompt) return showInstructions();
  const prompt = installPrompt;
  installPrompt = undefined;
  await prompt.prompt();
  await prompt.userChoice;
}

// Only the tab whose user asked to refresh may reload. Other open editors keep working.
const [updateAvailable, setUpdateAvailable] = createSignal(false);
export { updateAvailable };
let refreshRequested = false;
let activated = false;
let swRegistration: ServiceWorkerRegistration | undefined;
const updateSW = registerSW({
  onNeedRefresh: () => setUpdateAvailable(true),
  onNeedReload: () => {
    activated = true;
    if (refreshRequested) window.location.reload();
    else setUpdateAvailable(true);
  },
  onRegisteredSW: (_url, registered) => {
    swRegistration = registered;
    if (!registered) return;
    const registration = registered;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState !== "visible" || !navigator.onLine || registration.installing) return;
      checking = true;
      try {
        await registration.update();
      } catch {
        // Offline or a failed deployment: keep editing and retry next time.
      } finally {
        checking = false;
      }
    };
    window.setInterval(check, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
  },
});

export async function refreshApp(): Promise<void> {
  refreshRequested = true;
  if (activated) window.location.reload();
  else {
    const waiting = swRegistration?.waiting;
    if (!waiting) {
      // Another tab may already have activated it, or this page was not yet controlled.
      window.location.reload();
      return;
    }
    waiting.addEventListener("statechange", () => {
      if (waiting.state === "activated") window.location.reload();
    });
    await updateSW();
  }
}
