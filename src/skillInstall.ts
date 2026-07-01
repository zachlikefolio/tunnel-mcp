import { cpSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFlag } from './env.js';

const SKILL_NAME = 'tunnel-etiquette';

// dist/skillInstall.js → package root is one level up. During tests (tsx runs
// src/skillInstall.ts) this resolves to the repo root, which has the same
// `skill/` and `package.json` layout as the published package.
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function bundledSkillDir(): string {
  return path.join(packageRoot(), 'skill', SKILL_NAME);
}

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function defaultSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** Precedence: explicit arg → $TUNNEL_SKILLS_DIR → ~/.claude/skills. */
export function resolveSkillsDir(explicit?: string): string {
  return explicit || process.env.TUNNEL_SKILLS_DIR || defaultSkillsDir();
}

function targetDir(skillsDir: string): string {
  return path.join(skillsDir, SKILL_NAME);
}

export function isSkillInstalled(skillsDir: string = resolveSkillsDir()): boolean {
  return existsSync(path.join(targetDir(skillsDir), 'SKILL.md'));
}

export interface InstallResult {
  installed: boolean; // did we write files this call?
  updated: boolean; // did an install already exist (i.e. we overwrote)?
  target: string;
  source: string;
}

export function installSkill(
  opts: { skillsDir?: string; overwrite?: boolean } = {},
): InstallResult {
  const source = bundledSkillDir();
  if (!existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error(`bundled tunnel-etiquette skill not found at ${source}`);
  }
  const skillsDir = resolveSkillsDir(opts.skillsDir);
  const target = targetDir(skillsDir);
  const existed = existsSync(path.join(target, 'SKILL.md'));
  if (existed && !opts.overwrite) {
    return { installed: false, updated: false, target, source };
  }
  cpSync(source, target, { recursive: true });
  return { installed: true, updated: existed, target, source };
}

/**
 * Called from the postinstall script. Best-effort by contract: it must never
 * throw (a failed skill copy must not fail `npm install`), it only installs
 * when absent (never clobbers a user's copy on reinstall), and it bows out
 * under CI or when the user opts out.
 */
export function installSkillBestEffort(log: (msg: string) => void = () => {}): void {
  if (envFlag('TUNNEL_SKIP_SKILL_INSTALL') || envFlag('CI')) return;
  try {
    const res = installSkill({ overwrite: false });
    if (res.installed) log(`tunnel-mcp: installed the tunnel-etiquette skill to ${res.target}`);
  } catch {
    /* never break an install */
  }
}
