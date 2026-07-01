// Best-effort: install the tunnel-etiquette skill into ~/.claude/skills when the
// package is installed. This MUST never fail an install and is deliberately a
// no-op in the cases where it can't or shouldn't run:
//   - `npm install --ignore-scripts` (and hosts that disable scripts) skip it
//   - CI, or TUNNEL_SKIP_SKILL_INSTALL=1, opt out (see installSkillBestEffort)
//   - a dev checkout before `npm run build` has no dist/ yet → import throws → ignored
// It IS idempotent, so running again (e.g. npx populating its cache) is harmless.
try {
  const { installSkillBestEffort } = await import('./dist/skillInstall.js');
  installSkillBestEffort((m) => console.error(m));
} catch {
  /* dist not built yet, or any other error — never break the install */
}
