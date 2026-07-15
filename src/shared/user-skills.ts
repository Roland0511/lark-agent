import type { WorkerUserSkill } from "./contracts.js";
import { sha256 } from "./crypto.js";

export function workerUserSkillsFingerprint(skills: readonly WorkerUserSkill[]): string {
  const canonical = skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    displayName: skill.displayName,
    shortDescription: skill.shortDescription,
    relativePath: skill.relativePath,
    dependencies: skill.dependencies.map((dependency) => ({
      type: dependency.type,
      value: dependency.value,
      description: dependency.description
    })),
    skillhub: skill.skillhub ? { coordinate: skill.skillhub.coordinate, version: skill.skillhub.version } : null
  })).sort((left, right) => `${left.name}:${left.relativePath}`.localeCompare(`${right.name}:${right.relativePath}`));
  return sha256(JSON.stringify(canonical));
}
