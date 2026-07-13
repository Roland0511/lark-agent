import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/runner", { recursive: true });
await build({
  entryPoints: ["src/worker/main.ts"],
  outfile: "dist/runner/worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  banner: { js: "import { createRequire as __runnerCreateRequire } from 'node:module'; const require = __runnerCreateRequire(import.meta.url);" },
  target: "node24",
  sourcemap: false,
  minify: false,
  legalComments: "none"
});
