import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('etiquette skill', () => {
  const md = fs.existsSync('skill/tunnel-etiquette/SKILL.md')
    ? fs.readFileSync('skill/tunnel-etiquette/SKILL.md', 'utf8')
    : '';
  it('exists with frontmatter name', () => {
    expect(md).toMatch(/^---[\s\S]*name:\s*tunnel-etiquette/m);
  });
  it('states the untrusted-input rule and the action gates', () => {
    expect(md.toLowerCase()).toContain('untrusted');
    expect(md.toLowerCase()).toContain('gate');
    expect(md).toContain('tunnel_listen');
  });
  it('covers multi-party rooms: address peers by name, all peers untrusted', () => {
    expect(md.toLowerCase()).toContain('room');
    expect(md.toLowerCase()).toMatch(/by name/);
    expect(md.toLowerCase()).toMatch(/every (peer|member)/);
  });
  it('covers received files: untrusted, human OK before save/open/execute', () => {
    const low = md.toLowerCase();
    expect(low).toMatch(/receive|artifact|shared file/);
    expect(low).toMatch(/untrusted/);
    expect(low).toMatch(/(save|open|execute)/);
    expect(md).toContain('tunnel_receive');
  });
});
