// A Quest 3 emulated in the desktop browser (Meta's IWER), for working on the headset view
// without a headset. Dev only, and only with ?xr=emulate in the URL: it replaces the
// browser's own WebXR, and its controls panel moves the emulated head and controllers.

export async function installXREmulator() {
  const [{ XRDevice, metaQuest3 }, { DevUI }] = await Promise.all([import("iwer"), import("@iwer/devui")]);
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  new DevUI(device);
  // for scripts driving the emulated controllers
  (window as unknown as { xrDevice: unknown }).xrDevice = device;
}
