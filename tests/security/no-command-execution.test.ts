import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SECURITY SUITE 7 — ARBITRARY COMMAND EXECUTION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE CAN AND CANNOT ESTABLISH — READ BEFORE TRUSTING IT
 *
 * §39 defines suite 7 as two claims: "no path reaches host command execution",
 * and "sandbox escape attempts fail".
 *
 * The FIRST is testable now and is what this file asserts. It is a real
 * property with a real consequence: an agent's tool set contains no way to run
 * a command, because the shipped application contains no way to run a command
 * at all. There is no `exec` to reach, no `vm` to escape from, and no `eval`
 * for a prompt to talk its way into.
 *
 * The SECOND cannot be tested, because there is no sandbox — the coding agent
 * and its isolation are Phase 8, which cannot be built on this machine
 * (Windows 11 Home has no Hyper-V and no gVisor). §45 forbids shipping
 * something that merely appears to sandbox, so nothing does.
 *
 * That makes this suite a check on the CURRENT posture rather than on a
 * defence. The current posture is strong precisely because the capability is
 * absent: the safest way to survive a sandbox escape is to have nothing to
 * escape from. This suite exists to make sure that stays true by accident as
 * little as possible — the day someone adds `child_process` to a service, it
 * fails, and the conversation happens before the merge rather than after.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Directories that ship as the running application.
 *
 * Build tooling, migrations, drills and infrastructure scripts legitimately
 * run commands — the dev cluster script starts PostgreSQL, the backup script
 * calls pg_dump. Those are operator tools invoked from a shell, not code
 * reachable from a request, and scanning them would produce noise that trains
 * people to ignore this test.
 */
const SHIPPED_ROOTS = [
  join(REPO_ROOT, 'apps', 'api', 'src'),
  join(REPO_ROOT, 'apps', 'web', 'src'),
  join(REPO_ROOT, 'packages'),
];

/** Excluded from the scan, with the reason. */
const EXCLUDED = [
  /[\\/]node_modules[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]\.next[\\/]/,
  // Tests may use whatever they need to test the layers below.
  /\.test\.ts$/,
  /\.spec\.ts$/,
  // Fixtures are data, not code paths.
  /__fixtures__/,
];

function sourceFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(directory, entry);
      if (EXCLUDED.some((pattern) => pattern.test(full))) continue;

      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|mts|cts)$/.test(full)) {
        found.push(full);
      }
    }
  };

  for (const root of SHIPPED_ROOTS) walk(root);
  return found;
}

const FILES = sourceFiles();

/**
 * Strip comments before scanning.
 *
 * This codebase discusses `eval` and `child_process` at length in comments,
 * precisely because they are forbidden. A scanner that flagged the discussion
 * would fail on its own documentation, and the fix people would reach for is
 * deleting the explanation.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the scan covers the application', () => {
  it('found a substantial number of shipped source files', () => {
    // A scanner that silently matched nothing would pass every assertion
    // below while checking nothing at all.
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('includes the services most likely to grow an execution path', () => {
    const names = FILES.map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'));
    for (const expected of [
      'apps/api/src/modules/agents/tool-backend.service.ts',
      'apps/api/src/modules/research/crawler.service.ts',
      'packages/agents/src/registry.ts',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('nothing in the shipped application can run a command', () => {
  const FORBIDDEN_MODULES = [
    'child_process',
    'node:child_process',
    'worker_threads',
    'node:worker_threads',
    'node:vm',
    "from 'vm'",
  ];

  it('imports no process-spawning or code-evaluating module', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const body = code(file);
      for (const module of FORBIDDEN_MODULES) {
        if (body.includes(module)) {
          offenders.push(`${relative(REPO_ROOT, file)} → ${module}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('calls no process-spawning function', () => {
    /*
     * Only names that can mean nothing else. Bare `exec` and `fork` are
     * deliberately absent: `RegExp.prototype.exec` is used throughout this
     * codebase, and a check that flagged it would be switched off within a
     * week — which is worse than not having it.
     *
     * The import ban above is the load-bearing control: `spawn` cannot be
     * called without reaching `child_process`. This catches a call that
     * arrived some other way, such as through a transitive re-export.
     */
    const offenders: string[] = [];
    const pattern = /\b(spawnSync|spawn|execSync|execFileSync|execFile)\s*\(/;

    for (const file of FILES) {
      const match = pattern.exec(code(file));
      if (match) offenders.push(`${relative(REPO_ROOT, file)} → ${match[1]}`);
    }

    expect(offenders).toEqual([]);
  });

  it('evaluates no string as code', () => {
    /*
     * The prompt-injection-adjacent one. A model's output reaches this system
     * as text on several paths — a tool call, a chat reply, a research answer
     * — and any of them meeting `eval` would turn persuasion into execution.
     */
    const offenders: string[] = [];
    const patterns = [/\beval\s*\(/, /new\s+Function\s*\(/, /\bvm\.run/];

    for (const file of FILES) {
      const body = code(file);
      for (const pattern of patterns) {
        if (pattern.test(body)) offenders.push(`${relative(REPO_ROOT, file)} → ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has no agent tool that runs anything', async () => {
    /*
     * Asserted against the real registry rather than by reading the file. §19
     * says there is deliberately no `runSql`, `shell` or `fetchUrl` tool, and
     * this is what keeps that true as tools are added.
     */
    const { buildRegistry } = await import('@moka/agents');
    const backend = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('the registry must not execute anything during construction');
        },
      },
    );

    const registry = buildRegistry(backend as never);
    const names = [...registry.keys()];

    expect(names.length).toBeGreaterThan(0);
    for (const forbidden of ['run_sql', 'sql', 'query', 'shell', 'exec', 'run_command', 'eval']) {
      expect({ forbidden, present: names.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });
});

describe('what is NOT covered, stated so it cannot be mistaken for coverage', () => {
  it('records that no sandbox exists to escape from', () => {
    /*
     * The second half of §39 suite 7 is untestable here and must not be
     * quietly implied. Windows 11 Home has no Hyper-V and no gVisor, so
     * genuine isolation for AI-generated code cannot be built on this machine,
     * and §45 forbids shipping something that merely appears to sandbox.
     *
     * This assertion is documentation with a failure mode: if a sandbox is
     * ever added, `SANDBOX_PACKAGE` will exist, this test will fail, and
     * whoever added it will have to replace this with real escape tests.
     */
    const sandboxPackage = join(REPO_ROOT, 'packages', 'sandbox');
    let exists = true;
    try {
      statSync(sandboxPackage);
    } catch {
      exists = false;
    }

    expect({
      claim: 'no sandbox is shipped, so there are no escape tests',
      sandboxExists: exists,
    }).toEqual({ claim: 'no sandbox is shipped, so there are no escape tests', sandboxExists: false });
  });
});
