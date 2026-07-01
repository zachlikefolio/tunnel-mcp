import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, helpText, runInstallSkill } from '../src/cli.js';

describe('parseArgs', () => {
  it('defaults to serve with no args', () => {
    expect(parseArgs([])).toEqual({ mode: 'serve' });
  });

  it('recognizes help flags', () => {
    for (const a of ['--help', '-h', 'help']) {
      expect(parseArgs([a])).toEqual({ mode: 'help' });
    }
  });

  it('recognizes version flags', () => {
    for (const a of ['--version', '-v']) {
      expect(parseArgs([a])).toEqual({ mode: 'version' });
    }
  });

  it('parses install-skill with no options', () => {
    expect(parseArgs(['install-skill'])).toEqual({
      mode: 'install-skill',
      dir: undefined,
      force: false,
    });
  });

  it('parses install-skill --force and --dir (both spellings)', () => {
    expect(parseArgs(['install-skill', '--force'])).toMatchObject({
      mode: 'install-skill',
      force: true,
    });
    expect(parseArgs(['install-skill', '-f'])).toMatchObject({ force: true });
    expect(parseArgs(['install-skill', '--dir', '/a/b'])).toMatchObject({ dir: '/a/b' });
    expect(parseArgs(['install-skill', '--dir=/c/d'])).toMatchObject({ dir: '/c/d' });
  });

  it('errors on a dangling --dir', () => {
    expect(parseArgs(['install-skill', '--dir'])).toMatchObject({ mode: 'error' });
  });

  it('errors rather than swallowing a following flag or an empty --dir=', () => {
    expect(parseArgs(['install-skill', '--dir', '--force'])).toMatchObject({ mode: 'error' });
    expect(parseArgs(['install-skill', '--dir='])).toMatchObject({ mode: 'error' });
  });

  it('errors on an unknown command', () => {
    expect(parseArgs(['frobnicate'])).toMatchObject({ mode: 'error' });
  });
});

describe('helpText', () => {
  it('explains it is not an interactive CLI and how to wire it up', () => {
    const t = helpText('9.9.9');
    expect(t).toContain('9.9.9');
    expect(t.toLowerCase()).toContain('not an interactive cli');
    expect(t).toContain('claude mcp add');
    expect(t).toContain('install-skill');
    expect(t).toContain('--version');
    expect(t).toContain('TUNNEL_SKIP_REACHABILITY_CHECK');
    expect(t).toContain('TUNNEL_SKIP_SKILL_INSTALL');
  });
});

describe('runInstallSkill', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  function freshDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-cli-test-'));
    tmpDirs.push(d);
    return d;
  }

  it('installs, reports the path, and is idempotent without --force', () => {
    const dir = freshDir();
    const lines: string[] = [];
    const out = (m: string) => lines.push(m);

    expect(runInstallSkill({ dir, force: false }, out)).toBe(0);
    expect(lines.join('\n')).toContain(path.join(dir, 'tunnel-etiquette'));
    expect(fs.existsSync(path.join(dir, 'tunnel-etiquette', 'SKILL.md'))).toBe(true);

    lines.length = 0;
    expect(runInstallSkill({ dir, force: false }, out)).toBe(0);
    expect(lines.join('\n').toLowerCase()).toContain('already');

    lines.length = 0;
    expect(runInstallSkill({ dir, force: true }, out)).toBe(0);
    expect(lines.join('\n').toLowerCase()).toMatch(/installed|overwrote|updated/);
  });
});
