/**
 * The `hub` fixture: every test gets its own running Tutr on its own copy of a library, with the AI model and the
 * speech models replaced by a scripted double (harness/fake_hub.py). Tests drive the app only through the browser
 * and HTTP, and inspect the library folder on disk (the product's data contract: me/, course.json, ...).
 *
 *   test('...', async ({ page, hub }) => {
 *     await hub.script([{ match: { label: '^chat:' }, reply: { text: 'Hello' } }]);
 *     await page.goto('/#c=Demo-Course');
 *     expect(await hub.calls('^chat:')).toHaveLength(1);
 *   });
 *
 * Options (test.use): `library` (a folder under tests/e2e/libraries, or 'example' for example-library) and
 * `seed` (a function given the library path, run before the hub starts, to put the library in a given state).
 */
import { test as base, expect, APIRequestContext } from '@playwright/test';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const E2E = path.resolve(__dirname, '..');
export const REPO = path.resolve(E2E, '..', '..');
const RUNS = path.join(E2E, '.runs', 'hubs');
const PYTHON = process.env.PYTHON || 'python';
const LAUNCHER = process.env.TUTR_E2E_LAUNCHER || path.join(E2E, 'harness', 'fake_hub.py');

/** One scripted answer rule for the model double. See tests/e2e/README.md. */
export type Rule = {
  match?: { label?: string; prompt?: string; system?: string };
  times?: number;
  reply?: {
    text?: string;
    json?: unknown;
    chunks?: string[];
    chunk_delay_ms?: number;
    status?: string[];
    wait_for?: string;
    wait_after_status?: string;
    error?: string;
    error_after_text?: string;
    error_status?: number;
    crash?: boolean;
    stream_json_text?: boolean;
    cost?: number;
    ms?: number;
    tokens?: { in: number; cache_read: number; cache_write: number; out: number };
  };
};

export type ModelCall = {
  t: number; label: string; model?: string; schema?: boolean; web?: boolean; session?: string | null;
  fork?: boolean; chat_key?: string[] | null; course?: string; prompt: string; system?: string;
};

export class Hub {
  url = '';
  proc?: ChildProcess;
  output = '';
  constructor(public dir: string, public library: string, public work: string, public phoneUrl?: string) {}

  async start(port?: number) {
    fs.rmSync(path.join(this.work, 'port'), { force: true });
    const argv = [LAUNCHER, '--library', this.library, '--work', this.work];
    if (port) argv.push('--port', String(port));
    if (this.phoneUrl) argv.push('--phone-url', this.phoneUrl);
    this.proc = spawn(PYTHON, argv, { cwd: REPO, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.proc.stdout?.on('data', (d) => (this.output += d));
    this.proc.stderr?.on('data', (d) => (this.output += d));
    const portFile = path.join(this.work, 'port');
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      if (this.proc.exitCode !== null) throw new Error(`hub exited early:\n${this.output}`);
      if (fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim()) {
        this.url = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()}`;
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`hub didn't start in 90 s:\n${this.output}`);
  }

  async stop() {
    if (this.proc && this.proc.exitCode === null) {
      const exited = new Promise((r) => this.proc!.once('exit', r));
      this.proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
  }

  /** Stop and start the hub on the same library and scratch folder. The port changes unless `samePort` (then
   * open pages keep talking to it, as they would after a real restart of the app). */
  async restart(opts: { samePort?: boolean } = {}) {
    const port = opts.samePort ? Number(new URL(this.url).port) : undefined;
    await this.stop();
    const end = Date.now() + 15_000;
    for (;;) {
      try {
        await this.start(port);
        return;
      } catch (e) {
        if (!port || Date.now() > end) throw e;       // the old socket may take a moment to be released
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  /** Replace the model double's script. Rules are tried in order; the first that matches (and has uses left) answers. */
  async script(rules: Rule[]) {
    fs.writeFileSync(path.join(this.work, 'model-script.json'), JSON.stringify({ rules }, null, 1));
  }

  /** Every model call so far (optionally only those whose label matches), oldest first. */
  async calls(label?: string): Promise<ModelCall[]> {
    const f = path.join(this.work, 'model-calls.jsonl');
    if (!fs.existsSync(f)) return [];
    const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return label ? rows.filter((r) => new RegExp(label).test(r.label)) : rows;
  }

  /** Every sentence sent to text-to-speech so far. */
  async spoken(): Promise<{ text: string; voice: string; speed: number }[]> {
    const f = path.join(this.work, 'speak-calls.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Let a model reply scripted with `wait_for: name` finish. */
  async release(name: string) {
    fs.writeFileSync(path.join(this.work, `release-${name}`), '1');
  }

  /** A path inside the library copy. */
  path(...parts: string[]) {
    return path.join(this.library, ...parts);
  }
  exists(...parts: string[]) {
    return fs.existsSync(this.path(...parts));
  }
  read(...parts: string[]) {
    return fs.readFileSync(this.path(...parts), 'utf8');
  }
  readJson<T = any>(...parts: string[]): T {
    return JSON.parse(this.read(...parts));
  }
  write(rel: string, content: string | Buffer) {
    const p = this.path(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  /** Files (relative, forward slashes) under a folder of the library, recursively. */
  list(rel = ''): string[] {
    const root = this.path(rel);
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(root, p).split(path.sep).join('/'));
      }
    };
    walk(root);
    return out.sort();
  }
}

/** `test.use({ seed: seedWith((hub) => ...) })`: puts the library in a given state before the hub starts.
 * (Playwright reads a bare function in test.use as a fixture, so the function is handed over by one.) */
export function seedWith(fn: (hub: Hub) => void | Promise<void>): any {
  // eslint-disable-next-line no-empty-pattern
  return async ({}, use: (v: unknown) => Promise<void>) => { await use(fn); };
}

export function copyDir(src: string, dst: string) {
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.includes('__pycache__') });
}

export function libraryPath(name: string) {
  return name === 'example' ? path.join(REPO, 'example-library') : path.join(E2E, 'libraries', name);
}

type Fixtures = {
  library: string;
  seed: ((hub: Hub) => void | Promise<void>) | null;
  phoneUrl: string | undefined;
  hub: Hub;
  api: APIRequestContext;
};

export const test = base.extend<Fixtures>({
  library: ['example', { option: true }],
  seed: [null, { option: true }],
  phoneUrl: [undefined, { option: true }],

  // Its own timeout: starting a hub on a loaded machine shouldn't eat the test's time.
  hub: [async ({ library, seed, phoneUrl }, use, testInfo) => {
    const id = crypto.createHash('sha1').update(testInfo.testId + testInfo.retry).digest('hex').slice(0, 10);
    const dir = path.join(RUNS, `${testInfo.workerIndex}-${id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const lib = path.join(dir, 'library');
    copyDir(libraryPath(library), lib);
    const hub = new Hub(dir, lib, path.join(dir, 'work'), phoneUrl);
    fs.mkdirSync(hub.work, { recursive: true });
    if (seed) await seed(hub);
    await hub.start();
    await use(hub);
    await hub.stop();
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('hub-output', { body: hub.output, contentType: 'text/plain' });
      const calls = path.join(hub.work, 'model-calls.jsonl');
      if (fs.existsSync(calls)) await testInfo.attach('model-calls', { path: calls, contentType: 'text/plain' });
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 120_000 }],

  baseURL: async ({ hub }, use) => {
    await use(hub.url);
  },

  api: async ({ playwright, hub }, use) => {
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };
