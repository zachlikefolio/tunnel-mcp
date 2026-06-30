import { describe, it, expect } from 'vitest';
import { cloudflaredDownloadUrl, cloudflaredBinName } from '../src/cloudflared/provision.js';

describe('cloudflared provision', () => {
  it('maps darwin/arm64 to the tgz release asset', () => {
    expect(cloudflaredDownloadUrl('darwin', 'arm64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz');
  });

  it('maps linux/x64 to the amd64 raw binary', () => {
    expect(cloudflaredDownloadUrl('linux', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64');
  });

  it('maps win32/x64 to the .exe asset', () => {
    expect(cloudflaredDownloadUrl('win32', 'x64'))
      .toBe('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
  });

  it('names the binary per platform', () => {
    expect(cloudflaredBinName('darwin')).toBe('cloudflared');
    expect(cloudflaredBinName('win32')).toBe('cloudflared.exe');
  });

  it('throws on an unsupported platform', () => {
    expect(() => cloudflaredDownloadUrl('aix' as NodeJS.Platform, 'x64')).toThrow();
  });
});
