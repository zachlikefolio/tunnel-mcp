/**
 * True only when an env var is set to a meaningfully "on" value. Unset, '', '0',
 * 'false', 'no', and 'off' (any case, trimmed) all read as off — so `FOO=0`
 * disables a flag instead of accidentally enabling it (a plain `process.env.FOO`
 * truthiness check treats "0"/"false" as true).
 */
export function envFlag(name: string): boolean {
  const v = process.env[name];
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}
