#!/usr/bin/env node
/**
 * `npm run ops:verify-web -- https://hr.example.com [--allow-http] [--insecure-tls]`
 *
 * Checks a LIVE deployment against the web delivery contract (deploy/security-headers.json, Task 46): the HTML shell,
 * a client-side route (SPA fallback), a hashed asset, a missing source map and the API — headers, cache policy and who
 * set them. Exit 0 when everything matches, 1 otherwise. Reads nothing but public responses; sends no credentials.
 *
 *   --allow-http    accept a plain-HTTP origin (local verification only; HSTS is then not expected)
 *   --insecure-tls  accept a self-signed certificate (local verification only)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(readFileSync(join(root, 'deploy/security-headers.json'), 'utf8'));
const args = process.argv.slice(2);
const origin = args.find((a) => !a.startsWith('--'))?.replace(/\/+$/, '');
const allowHttp = args.includes('--allow-http');
if (args.includes('--insecure-tls')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
if (!origin || !/^https?:\/\//.test(origin)) {
  console.error('usage: npm run ops:verify-web -- https://hr.example.com [--allow-http] [--insecure-tls]');
  process.exit(2);
}
const https = origin.startsWith('https://');
if (!https && !allowHttp) {
  console.error('The origin is not https. Production must be served over TLS; pass --allow-http only for a local check.');
  process.exit(2);
}

const failures = [];
const rows = [];
const check = (where, header, actual, expected, ok = actual === expected) => {
  rows.push({ where, header, value: actual ?? '(missing)', ok });
  if (!ok) failures.push(`${where}: ${header} = ${actual ?? '(missing)'} — expected ${expected}`);
};
const get = async (path) => fetch(origin + path, { redirect: 'manual' });

const webHeaders = async (where, res) => {
  for (const [name, value] of Object.entries(contract.web)) check(where, name, res.headers.get(name), value);
  if (https) check(where, 'Strict-Transport-Security', res.headers.get('strict-transport-security'), contract.tlsOnly['Strict-Transport-Security']);
};

// 1. HTML shell
const home = await get('/');
check('/', 'status', String(home.status), '200');
check('/', 'Content-Type', home.headers.get('content-type'), 'text/html', /^text\/html/.test(home.headers.get('content-type') ?? ''));
check('/', 'Cache-Control', home.headers.get('cache-control'), contract.cache.html);
await webHeaders('/', home);
const html = await home.text();

// 2. A client-side route must be the same shell with the same headers (SPA fallback)
const deep = await get('/hrm/leave');
check('/hrm/leave', 'status', String(deep.status), '200');
check('/hrm/leave', 'Cache-Control', deep.headers.get('cache-control'), contract.cache.html);
await webHeaders('/hrm/leave', deep);

// 3. A hashed asset is cacheable forever
const asset = html.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/)?.[1];
if (!asset) failures.push('/: no /assets/*.js script found in the HTML shell');
else {
  const res = await get(asset);
  check(asset, 'status', String(res.status), '200');
  check(asset, 'Cache-Control', res.headers.get('cache-control'), contract.cache.hashedAssets);
  check(asset, 'X-Content-Type-Options', res.headers.get('x-content-type-options'), 'nosniff');
  // 4. no public source map, and a missing asset is a real 404 (not the HTML shell)
  const map = await get(`${asset}.map`);
  check(`${asset}.map`, 'status', String(map.status), '404');
}

// 5. The API keeps its own strict headers through the proxy
const api = await get('/api/v1/health/live');
check('/api/v1/health/live', 'status', String(api.status), '200');
check('/api/v1/health/live', 'Cache-Control', api.headers.get('cache-control'), contract.cache.api);
if (https) check('/api/v1/health/live', 'Strict-Transport-Security (exactly one)', api.headers.get('strict-transport-security'), contract.tlsOnly['Strict-Transport-Security']);
check('/api/v1/health/live', 'Content-Security-Policy', api.headers.get('content-security-policy'), "default-src 'none' (API policy)", /^default-src 'none'/.test(api.headers.get('content-security-policy') ?? ''));

const width = Math.max(...rows.map((r) => r.where.length));
for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.where.padEnd(width)}  ${r.header}: ${r.value}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`\nWeb delivery contract verified for ${origin}${https ? '' : ' (HTTP — HSTS not checked)'}.`);
