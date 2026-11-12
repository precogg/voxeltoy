// Run the sharing API (the Worker, with local Durable Objects) next to Vite, which proxies /api
// to it. Both stop together.
import { spawn } from "node:child_process";

const children = [
  spawn("npx", ["wrangler", "dev", "--experimental-new-config", "--port", "8787", "--log-level", "warn"], {
    stdio: "inherit",
    cwd: new URL("../worker/", import.meta.url),
  }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
for (const child of children) child.on("exit", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
