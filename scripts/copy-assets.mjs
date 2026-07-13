import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/db", { recursive: true });
await cp("src/db/migrations", "dist/db/migrations", { recursive: true });
