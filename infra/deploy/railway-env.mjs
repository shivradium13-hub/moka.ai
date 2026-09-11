/**
 * Build — and VALIDATE — the Railway environment block.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN A LIST TO COPY BY HAND
 *
 * The API refuses to boot on any of a dozen production misconfigurations, and
 * that is the correct behaviour — but discovering them one at a time through a
 * remote deploy log is a slow and demoralising way to find out. Each round trip
 * is a build, a deploy, a crash, and a scroll.
 *
 * So this runs the REAL config loader over the variables it is about to emit.
 * Not a copy of the rules, not a checklist that can drift — `loadConfig` from
 * @moka/config, the same function `main.ts` calls at startup. If this script
 * prints a block, that block has already satisfied every guard the application
 * enforces, including the ones added for split-domain cookies.
 *
 * It writes to `local/`, which is gitignored, because the output contains the
 * master encryption key.
 *
 * Usage:
 *   node infra/deploy/railway-env.mjs \
 *     --db-host   <host>:<port> \
 *     --app-url   https://your-project.vercel.app
 *
 * Optional:
 *   --db-name     defaults to moka_ai
 *   --redis-url   defaults to a placeholder you must replace
 *   --same-site   lax | none  (defaults to none; see below)
 *   --cookie-domain .yourdomain.com
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '@moka/config';
import process from 'node:process';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const dbHost = arg('db-host');
const appUrl = arg('app-url');

if (!dbHost || !appUrl) {
  console.error(
    'Usage: node infra/deploy/railway-env.mjs --db-host <host:port> --app-url https://<app>\n\n' +
      '  --db-host   the PostgreSQL host and port, e.g. ep-x.eu-central-1.aws.neon.tech\n' +
      '  --app-url   the deployed web app origin, e.g. https://moka.vercel.app',
  );
  process.exit(1);
}

const dbName = arg('db-name', 'moka_ai');
const redisUrl = arg('redis-url', 'redis://REPLACE_ME:6379');
const cookieDomain = arg('cookie-domain');

/*
 * SameSite defaults to `none` here, which is the opposite of the application's
 * own default — deliberately.
 *
 * The application defaults to `lax` because that is the safer value for a
 * deployment that shares a registrable domain. This script exists to configure
 * a SPLIT deployment (Vercel + Railway), where `lax` means the browser sends
 * the session cookie on nothing at all and every request after login is a 401.
 *
 * Pass `--same-site lax` if you have put both behind one domain, which is the
 * better arrangement and costs no CSRF trade-off.
 */
const sameSite = arg('same-site', 'none');

// --- Secrets ----------------------------------------------------------------
// Read from the generated file rather than minted here, so that re-running this
// script cannot silently rotate ENCRYPTION_KEY. Rotating it would make every
// stored provider credential unreadable, and a helper script is the last place
// that should be able to cause it by accident.
let secrets;
try {
  secrets = readFileSync('local/deploy-secrets.txt', 'utf8');
} catch {
  console.error(
    'local/deploy-secrets.txt not found. Generate it first:\n\n' +
      '  node -e "const c=require(\'crypto\');console.log(\'AUTH_SECRET=\'+c.randomBytes(32).toString(\'base64\'));console.log(\'ENCRYPTION_KEY=\'+c.randomBytes(32).toString(\'base64\'))"',
  );
  process.exit(1);
}

const pick = (key) => {
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(secrets);
  if (!m) {
    console.error(`${key} not found in local/deploy-secrets.txt`);
    process.exit(1);
  }
  return m[1].trim();
};

const authSecret = pick('AUTH_SECRET');
const encryptionKey = pick('ENCRYPTION_KEY');
const appPassword = pick('APP_PASSWORD');
const migratorPassword = pick('MIGRATOR_PASSWORD');

const enc = encodeURIComponent;
const appDbUrl = `postgresql://moka_app:${enc(appPassword)}@${dbHost}/${dbName}?sslmode=require`;
const migDbUrl = `postgresql://moka_migrator:${enc(migratorPassword)}@${dbHost}/${dbName}?sslmode=require`;

const vars = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',

  DATABASE_URL: appDbUrl,
  DATABASE_MIGRATION_URL: migDbUrl,
  DATABASE_SSL: 'true',
  DATABASE_POOL_MAX: '10',

  AUTH_SECRET: authSecret,
  ENCRYPTION_KEY: encryptionKey,
  SESSION_TTL_SECONDS: '2592000',

  REDIS_URL: redisUrl,

  STORAGE_DRIVER: 'local',
  STORAGE_LOCAL_PATH: '/data/storage',

  CORS_ORIGINS: appUrl,
  COOKIE_SAMESITE: sameSite,
  ...(cookieDomain ? { COOKIE_DOMAIN: cookieDomain } : {}),

  API_HOST: '0.0.0.0',
};

/* -------------------------------------------------------------------------- */
/* Validate with the real loader before emitting anything                      */
/* -------------------------------------------------------------------------- */

try {
  loadConfig({ source: vars });
} catch (error) {
  console.error('These variables would NOT boot the application:\n');
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    '\nNothing was written. Fix the input above and re-run — this is the same\n' +
      'check main.ts performs at startup, so passing it here means the deploy\n' +
      'will get past configuration.',
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Emit                                                                        */
/* -------------------------------------------------------------------------- */

const block = Object.entries(vars)
  .map(([k, v]) => `${k}=${v}`)
  .join('\n');

const header = `# MOKA AI — Railway variables
# Generated ${new Date().toISOString()}
#
# VALIDATED: these passed loadConfig() from @moka/config — the same function
# main.ts calls at boot — so they satisfy every production guard, including
# DATABASE_URL not being a superuser, the two database roles differing, TLS,
# non-loopback host, no instance-wide provider keys, and the cookie rules.
#
# Paste into Railway -> Variables -> Raw Editor.
#
# GITIGNORED. Contains ENCRYPTION_KEY, the master key for the credential vault.
# Losing it makes every stored provider credential permanently unreadable.
#
# Do NOT add PORT or API_PORT: Railway injects PORT and the container derives
# API_PORT from it.

`;

mkdirSync('local', { recursive: true });
writeFileSync('local/railway-variables.txt', header + block + '\n');

console.log('Validated against the real config loader — these will boot.\n');
console.log(`  variables : ${Object.keys(vars).length}`);
console.log(`  database  : moka_app @ ${dbHost}/${dbName} (TLS required)`);
console.log(`  app origin: ${appUrl}`);
console.log(`  cookie    : SameSite=${sameSite}${cookieDomain ? `, Domain=${cookieDomain}` : ''}`);
if (redisUrl.includes('REPLACE_ME')) {
  console.log('\n  ! REDIS_URL is still a placeholder. Replace it before deploying.');
}
console.log('\nWritten to local/railway-variables.txt (gitignored).');
