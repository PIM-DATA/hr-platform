#!/usr/bin/env node
/**
 * `npm run verify:clean-build` — CI-style guard against build-order regressions (Task 46).
 *
 * Exports the committed tree (`git archive HEAD`) into a temporary directory — no node_modules, no generated Prisma
 * client, no dist, no .env — then runs exactly the documented path: `npm ci`, `npm run build`. It checks the outputs exist
 * and that no source map is published, then deletes the directory. Uncommitted changes are NOT included: commit first.
 * Needs network access for npm (or a warm npm cache). Exit 0 on success.
 *
 *   --worktree  verify the working tree instead (tracked + untracked, non-ignored files) — for checking a change before
 *               committing it; ignored files (node_modules, dist, .env, generated client) are still left out.
 *   --keep      keep the temporary directory for inspection
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'hr-clean-build-'));
const keep = process.argv.includes('--keep');
// A clean build must not depend on the developer's environment either.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|DATABASE_URL|TEST_DATABASE_URL|ENV_FILE)$/.test(k)));
const run = (cmd, argv, cwd = dir) => {
  const started = Date.now();
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  execFileSync(cmd, argv, { cwd, env: cleanEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`  ok (${((Date.now() - started) / 1000).toFixed(1)} s)`);
};
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

let ok = false;
try {
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.argv.includes('--worktree')) {
    console.log(`clean build of the working tree (HEAD ${head} + local changes) in ${dir}`);
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => f && existsSync(join(root, f)));
    const list = join(dir, '.file-list');
    writeFileSync(list, files.join('\n'));
    execFileSync('sh', ['-c', `tar -cf - -T "${list}" | tar -x -C "${dir}" && rm "${list}"`], { cwd: root, stdio: 'inherit' });
  } else {
    console.log(`clean build of ${head} in ${dir}`);
    execFileSync('sh', ['-c', `git archive --format=tar HEAD | tar -x -C "${dir}"`], { cwd: root, stdio: 'inherit' });
  }
  run('npm', ['ci', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build']);
  const required = ['packages/shared/dist/index.js', 'apps/api/dist/server.js', 'apps/web/dist/index.html'];
  const missing = required.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) throw new Error(`build outputs missing: ${missing.join(', ')}`);
  const maps = [...walk(join(dir, 'apps/web/dist')), ...walk(join(dir, 'apps/api/dist'))].filter((f) => f.endsWith('.map'));
  if (maps.length) throw new Error(`source maps would be published: ${maps.length} file(s)`);
  ok = true;
  console.log('\nClean-checkout build verified: npm ci → npm run build, outputs present, no source maps.');
} catch (err) {
  console.error(`\nClean-checkout build FAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (keep) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
