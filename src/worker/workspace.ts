import { mkdir, realpath, stat } from "node:fs/promises";
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

export async function resolveBotWorkspace(roots: WorkspaceRoot[], rootAlias: string | null, appId: string): Promise<BotWorkspace> {
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw new Error("task has an invalid bot app id");
  const root = rootAlias
    ? roots.find((candidate) => candidate.alias === rootAlias)
    : roots.length === 1 ? roots[0] : undefined;
  if (!root) {
    if (rootAlias) throw new Error(`executor cannot access total workspace alias ${rootAlias}`);
    throw new Error("task has no total workspace alias and executor has multiple workspace roots");
  }

  const rootPath = await realpath(root.path);
  const candidate = join(rootPath, appId);
  await mkdir(candidate, { recursive: true });
  const workspacePath = await realpath(candidate);
  const childPath = relative(rootPath, workspacePath);
  if (!childPath || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) {
    throw new Error("bot workspace resolves outside the configured total workspace");
  }
  if (!(await stat(workspacePath)).isDirectory()) throw new Error("bot workspace is not a directory");
  return { rootAlias: root.alias, alias: `${root.alias}/${appId}`, path: workspacePath };
}
