import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface WorkspaceRoot {
  alias: string;
  path: string;
}

export interface BotWorkspace {
  rootAlias: string;
  alias: string;
  path: string;
}

export interface ChatWorkspace extends BotWorkspace {
  chatContextId: string;
  workspaceKey: string;
}

const lowercaseCanonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function selectedRoot(roots: WorkspaceRoot[], rootAlias: string | null): Promise<{ alias: string; path: string }> {
  const root = rootAlias
    ? roots.find((candidate) => candidate.alias === rootAlias)
    : roots.length === 1 ? roots[0] : undefined;
  if (!root) {
    if (rootAlias) throw new Error(`executor cannot access total workspace alias ${rootAlias}`);
    throw new Error("task has no total workspace alias and executor has multiple workspace roots");
  }
  return { alias: root.alias, path: await realpath(root.path) };
}

function assertContained(rootPath: string, workspacePath: string): void {
  const childPath = relative(rootPath, workspacePath);
  if (!childPath || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw new Error("chat workspace resolves outside the configured total workspace");
  }
}

async function ensureContainedDirectory(rootPath: string, candidate: string, enforcePrivateMode = true): Promise<string> {
  const before = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (before?.isSymbolicLink()) throw new Error("chat workspace path must not contain a symbolic link");
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const after = await lstat(candidate);
  if (after.isSymbolicLink()) throw new Error("chat workspace path must not contain a symbolic link");
  const canonical = await realpath(candidate);
  assertContained(rootPath, canonical);
  if (!(await stat(canonical)).isDirectory()) throw new Error("chat workspace is not a directory");
  if (enforcePrivateMode) await chmod(canonical, 0o700);
  return canonical;
}

export async function resolveBotWorkspace(roots: WorkspaceRoot[], rootAlias: string | null, appId: string): Promise<BotWorkspace> {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error("task has an invalid bot app id");
  const root = await selectedRoot(roots, rootAlias);
  const workspacePath = await ensureContainedDirectory(root.path, join(root.path, appId), false);
  return { rootAlias: root.alias, alias: `${root.alias}/${appId}`, path: workspacePath };
}

export async function resolveChatWorkspace(
  roots: WorkspaceRoot[],
  rootAlias: string | null,
  appId: string,
  chatContextId: string,
  workspaceKey: string
): Promise<ChatWorkspace> {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error("task has an invalid bot app id");
  if (!lowercaseCanonicalUuid.test(chatContextId)) throw new Error("task has an invalid chat context id");
  if (!lowercaseCanonicalUuid.test(workspaceKey)) throw new Error("task has an invalid chat workspace key");
  if (workspaceKey !== chatContextId) throw new Error("chat workspace key does not match the chat context id");

  const root = await selectedRoot(roots, rootAlias);
  // The bot directory may be a pre-upgrade shared workspace. Keep its existing
  // permissions and contents untouched; privacy is enforced from `chats/` down.
  const botDirectory = await ensureContainedDirectory(root.path, join(root.path, appId), false);
  const chatsDirectory = await ensureContainedDirectory(root.path, join(botDirectory, "chats"));
  const workspacePath = await ensureContainedDirectory(root.path, join(chatsDirectory, workspaceKey));
  return {
    rootAlias: root.alias,
    alias: `${root.alias}/${appId}/chats/${workspaceKey}`,
    path: workspacePath,
    chatContextId,
    workspaceKey
  };
}
