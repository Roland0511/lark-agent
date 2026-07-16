import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/runner", { recursive: true });
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: "import { createRequire as __runnerCreateRequire } from 'node:module'; const require = __runnerCreateRequire(import.meta.url);" },
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "none"
};

await Promise.all([
  build({ ...common, entryPoints: ["src/worker/main.ts"], outfile: "dist/runner/worker.mjs" }),
  build({ ...common, entryPoints: ["src/manager/main.ts"], outfile: "dist/runner/manager.mjs" })
]);
