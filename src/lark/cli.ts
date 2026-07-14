import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { lstat, readdir } from "node:fs/promises";
import { AppError, errorMessage } from "../shared/errors.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  limitExceeded?: boolean;
}

export interface CommandOptions {
  cwd?: string;
  maxOutputDirectory?: string;
  maxOutputBytes?: number;
}

export async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, options: CommandOptions = {}): Promise<CommandResult> {
  return runCommandWithInput(command, args, undefined, env, options);
}

export async function runCommandWithInput(command: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env, options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let limitExceeded = false;
    let checkingSize = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const sizeMonitor = options.maxOutputDirectory && options.maxOutputBytes
      ? setInterval(() => {
          if (checkingSize || limitExceeded) return;
          checkingSize = true;
          void directorySize(options.maxOutputDirectory!).then((size) => {
            if (size > options.maxOutputBytes!) {
              limitExceeded = true;
              child.kill("SIGTERM");
              forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
              forceKillTimer.unref();
            }
          }).finally(() => { checkingSize = false; });
        }, 50)
      : null;
    sizeMonitor?.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      if (sizeMonitor) clearInterval(sizeMonitor);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (sizeMonitor) clearInterval(sizeMonitor);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ stdout, stderr, exitCode: code ?? -1, limitExceeded });
    });
    child.stdin.end(input);
  });
}

async function directorySize(directory: string): Promise<number> {
  const entries = await readdir(directory, { recursive: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const info = await lstat(`${directory}/${entry}`).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

export async function runJsonCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<unknown> {
  const result = await runCommand(command, args, env);
  if (result.exitCode !== 0) {
    let message = result.stderr.trim() || result.stdout.trim() || `command exited ${result.exitCode}`;
    try {
      const envelope = JSON.parse(result.stderr) as { error?: { message?: string; hint?: string } };
      message = [envelope.error?.message, envelope.error?.hint].filter(Boolean).join("; ") || message;
    } catch {
      // Keep the non-JSON diagnostic.
    }
    throw new AppError(`lark-cli failed: ${message}`, 502, "lark_cli_error");
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new AppError(`lark-cli returned invalid JSON: ${errorMessage(error)}`, 502, "lark_cli_invalid_json");
  }
}

/** lark-cli reserves exit 2 for validation/config errors and exit 3 for authentication errors. */
export function isPermanentConsumerExit(code: number | null): boolean {
  return code === 2 || code === 3;
}

export function consumerExitError(eventKey: string, code: number | null, stderr: string): Error {
  const jsonStart = stderr.indexOf("{");
  const jsonEnd = stderr.lastIndexOf("}");
  const embeddedJson = jsonStart >= 0 && jsonEnd > jsonStart ? stderr.slice(jsonStart, jsonEnd + 1) : "";
  const candidates = [stderr, embeddedJson, ...stderr.split("\n").reverse()];
  for (const candidate of candidates) {
    try {
      const envelope = JSON.parse(candidate) as { error?: { message?: string; hint?: string } };
      const detail = [envelope.error?.message, envelope.error?.hint].filter(Boolean).join("; ");
      if (detail) return new Error(detail);
    } catch {
      // lark-cli may mix progress lines and a JSON error envelope on stderr.
    }
  }
  return new Error(`${eventKey} consumer exited with ${code ?? -1}`);
}

export class NdjsonConsumer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: string,
    private readonly eventKey: string,
    private readonly onEvent: (event: unknown) => Promise<void>,
    private readonly onReady: (eventKey: string) => void,
    private readonly onError: (error: Error) => void,
    private readonly profileName?: string | null
  ) {}

  start(): void {
    if (this.child) return;
    this.stopping = false;
    const args = [...(this.profileName ? ["--profile", this.profileName] : []), "event", "consume", this.eventKey, "--as", "bot"];
    const child = spawn(this.command, args, {
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    let stderrText = "";
    stdout.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as unknown;
        void this.onEvent(event).catch((error) => this.onError(error instanceof Error ? error : new Error(String(error))));
      } catch (error) {
        this.onError(new Error(`invalid ${this.eventKey} NDJSON: ${errorMessage(error)}`));
      }
    });
    stderr.on("line", (line) => {
      stderrText += `${line}\n`;
      if (line.includes(`[event] ready event_key=${this.eventKey}`)) this.onReady(this.eventKey);
    });
    child.once("error", (error) => this.onError(error));
    child.once("close", (code) => {
      this.child = null;
      if (!this.stopping) {
        this.onError(consumerExitError(this.eventKey, code, stderrText.trim()));
        if (isPermanentConsumerExit(code)) return;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start();
        }, 2_000);
      }
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!child) return;
    child.stdin.end();
    const waitForClose = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const onClose = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      const finish = (closed: boolean) => {
        clearTimeout(timer);
        child.off("close", onClose);
        resolve(closed);
      };
      child.once("close", onClose);
    });
    if (!(await waitForClose(2_000))) {
      child.kill("SIGTERM");
      await waitForClose(3_000);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    this.child = null;
  }
}
