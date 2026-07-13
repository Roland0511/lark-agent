import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function parseEnv(source) {
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const values = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
const appId = values.get("BOT_APP_ID");
const appSecret = values.get("BOT_APP_SECRET");
if (!appId || !appSecret) {
  throw new Error("BOT_APP_ID and BOT_APP_SECRET must both be present in .env");
}

const child = spawn(
  "docker",
  [
    "compose",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "control",
    "lark-cli",
    "config",
    "init",
    "--app-id",
    appId,
    "--app-secret-stdin",
    "--brand",
    "feishu",
    "--lang",
    "zh"
  ],
  { cwd: projectRoot, stdio: ["pipe", "inherit", "inherit"] }
);

child.stdin.end(`${appSecret}\n`);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? -1));
});
if (exitCode !== 0) throw new Error(`lark-cli Docker volume initialization exited ${exitCode}`);

const secretWriter = spawn(
  "docker",
  [
    "compose",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "control",
    "node",
    "-e",
    "const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{const secretPath='/home/agent/.lark-cli/app-secret';const configPath='/home/agent/.lark-cli/config.json';fs.writeFileSync(secretPath,Buffer.concat(chunks),{mode:0o600});fs.chmodSync(secretPath,0o600);const config=JSON.parse(fs.readFileSync(configPath,'utf8'));config.apps[0].appSecret={source:'file',id:secretPath};fs.writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});fs.chmodSync(configPath,0o600);});"
  ],
  { cwd: projectRoot, stdio: ["pipe", "inherit", "inherit"] }
);
secretWriter.stdin.end(`${appSecret}\n`);
const writerExitCode = await new Promise((resolve, reject) => {
  secretWriter.once("error", reject);
  secretWriter.once("close", (code) => resolve(code ?? -1));
});
if (writerExitCode !== 0) throw new Error(`Docker secret file initialization exited ${writerExitCode}`);
