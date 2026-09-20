import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildPackages, EXTENSIONS } from '../scripts/package.mjs';

const root = new URL('../', import.meta.url);

test('each XPI has its manifest at the root, its own code, shared code and nothing else', async t => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'mail-xpi-test-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const outputs = await buildPackages({ outDir });
  for (const [i, name] of EXTENSIONS.entries()) {
    const entries = execFileSync('unzip', ['-Z1', outputs[i]], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(entries.includes('manifest.json') && entries.includes('LICENSE') && entries.includes('shared/options.html'));
    assert.ok(entries.includes(`extensions/${name}/core.js`) && entries.includes(`extensions/${name}/background.js`));
    assert.ok(!entries.includes(`extensions/${name}/manifest.json`));
    const foreign = new RegExp(`\\.md$|^tests/|^docs/|^extensions/(?!${name}/)`);
    assert.deepEqual(entries.filter(e => foreign.test(e)), []);
  }
});

test('release permissions: optional HTTPS access only, no send/delete', async () => {
  for (const name of EXTENSIONS) {
    const manifest = JSON.parse(await readFile(new URL(`extensions/${name}/manifest.json`, root)));
    assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
    assert.equal(manifest.host_permissions, undefined);
    assert.ok(!manifest.permissions.some(p => ['compose.send', 'messagesDelete'].includes(p)));
  }
});
