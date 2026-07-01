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
});
