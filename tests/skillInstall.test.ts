import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installSkill,
  installSkillBestEffort,
  isSkillInstalled,
  resolveSkillsDir,
  defaultSkillsDir,
  readVersion,
} from '../src/skillInstall.js';

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-skill-test-'));
  tmpDirs.push(d);
  return d;
}

const ENV_KEYS = ['TUNNEL_SKILLS_DIR', 'TUNNEL_SKIP_SKILL_INSTALL', 'CI'] as const;
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
});
function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe('installSkill', () => {
  it('copies the bundled tunnel-etiquette skill into the target dir', () => {
    const dir = freshDir();
    const res = installSkill({ skillsDir: dir });
    expect(res.installed).toBe(true);
    expect(res.updated).toBe(false);
    expect(res.target).toBe(path.join(dir, 'tunnel-etiquette'));
    expect(fs.existsSync(path.join(dir, 'tunnel-etiquette', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'tunnel-etiquette', 'SKILL.md'), 'utf8')).toContain(
      'tunnel-etiquette',
    );
  });

  it('does not overwrite an existing install unless asked (idempotent)', () => {
    const dir = freshDir();
    installSkill({ skillsDir: dir });
    // Tamper with the installed copy so we can detect an overwrite.
    const md = path.join(dir, 'tunnel-etiquette', 'SKILL.md');
    fs.writeFileSync(md, 'LOCAL EDIT');

    const again = installSkill({ skillsDir: dir });
    expect(again.installed).toBe(false); // left as-is
    expect(fs.readFileSync(md, 'utf8')).toBe('LOCAL EDIT');

    const forced = installSkill({ skillsDir: dir, overwrite: true });
    expect(forced.installed).toBe(true);
    expect(forced.updated).toBe(true);
    expect(fs.readFileSync(md, 'utf8')).not.toBe('LOCAL EDIT');
  });

  it('isSkillInstalled reflects presence', () => {
    const dir = freshDir();
    expect(isSkillInstalled(dir)).toBe(false);
    installSkill({ skillsDir: dir });
    expect(isSkillInstalled(dir)).toBe(true);
  });
});

describe('resolveSkillsDir', () => {
  it('prefers an explicit dir, then the env var, then the default', () => {
    setEnv('TUNNEL_SKILLS_DIR', '/from/env');
    expect(resolveSkillsDir('/explicit')).toBe('/explicit');
    expect(resolveSkillsDir()).toBe('/from/env');
    setEnv('TUNNEL_SKILLS_DIR', undefined);
    expect(resolveSkillsDir()).toBe(defaultSkillsDir());
    expect(defaultSkillsDir()).toBe(path.join(os.homedir(), '.claude', 'skills'));
  });
});

describe('readVersion', () => {
  it('returns the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(readVersion()).toBe(pkg.version);
  });
});

describe('installSkillBestEffort', () => {
  it('installs into the configured dir when nothing opts out', () => {
    const dir = freshDir();
    setEnv('TUNNEL_SKILLS_DIR', dir);
    setEnv('TUNNEL_SKIP_SKILL_INSTALL', undefined);
    setEnv('CI', undefined);
    installSkillBestEffort();
    expect(isSkillInstalled(dir)).toBe(true);
  });

  it('does nothing when TUNNEL_SKIP_SKILL_INSTALL is set', () => {
    const dir = freshDir();
    setEnv('TUNNEL_SKILLS_DIR', dir);
    setEnv('TUNNEL_SKIP_SKILL_INSTALL', '1');
    installSkillBestEffort();
    expect(isSkillInstalled(dir)).toBe(false);
  });

  it('does nothing under CI', () => {
    const dir = freshDir();
    setEnv('TUNNEL_SKILLS_DIR', dir);
    setEnv('TUNNEL_SKIP_SKILL_INSTALL', undefined);
    setEnv('CI', 'true');
    installSkillBestEffort();
    expect(isSkillInstalled(dir)).toBe(false);
  });

  it('treats =0 / =false as off (does NOT skip)', () => {
    const dir = freshDir();
    setEnv('TUNNEL_SKILLS_DIR', dir);
    setEnv('TUNNEL_SKIP_SKILL_INSTALL', '0');
    setEnv('CI', 'false');
    installSkillBestEffort();
    expect(isSkillInstalled(dir)).toBe(true);
  });
});
