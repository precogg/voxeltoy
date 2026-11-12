import { DialogFrame } from "@voxeltoy/sdk";

export function InstallDialog() {
  const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return (
    <DialogFrame title="Install Voxeltoy">
      <div class="dialog-body">
        <p>Add Voxeltoy to your home screen or desktop to open it as an app.</p>
        <p>{appleMobile
          ? "In Safari, open Share, choose Add to Home Screen, then tap Add. If shown, turn on Open as Web App."
          : "Open your browser’s menu and choose Install Voxeltoy or Add to Home Screen. In Safari on Mac, choose File → Add to Dock."}</p>
        <p class="hint">After one online visit, you can edit your local model offline. Sharing and live rooms need an internet connection.</p>
      </div>
    </DialogFrame>
  );
}
