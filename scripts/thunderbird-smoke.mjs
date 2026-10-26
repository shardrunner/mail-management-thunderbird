// Opt-in only. The coordinator must build first; this runner never invokes a build.
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function sandboxArguments(work, node, thunderbird) {
  return ['--unshare-net', '--die-with-parent', '--new-session',
    '--tmpfs', '/', '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib', '/lib64',
    '--tmpfs', '/home', '--tmpfs', '/root', '--tmpfs', '/run', '--tmpfs', '/tmp',
    '--proc', '/proc', '--dev', '/dev', '--bind', work, '/work', '--chdir', '/work', '--clearenv',
    '--setenv', 'HOME', '/work/home', '--setenv', 'XDG_CONFIG_HOME', '/work/home/config',
    '--setenv', 'XDG_CACHE_HOME', '/work/home/cache', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'MOZ_HEADLESS', '1',
    '--setenv', 'MOZ_NO_REMOTE', '1', '--setenv', 'THUNDERBIRD', thunderbird,
    '--ro-bind', node, '/work/node', '--', '/work/node', '/work/smoke-worker.mjs'];
}

async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Not launched. After integration/build, opt in with npm run test:thunderbird -- --run');
    return;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  // /tmp is deliberate: the sandbox hides the user's entire home and /run.
  const work = await mkdtemp('/tmp/mail-thunderbird-smoke-');
  console.log(`Synthetic profile/results retained at ${work}`);
  for (const directory of ['home', 'profile', 'probe']) await mkdir(path.join(work, directory));
  for (const name of ['compose', 'move']) {
    await cp(path.join(root, 'dist', `${name}.xpi`), path.join(work, `${name}.xpi`));
  }
  await cp(path.join(root, 'tests/integration/smoke-worker.mjs'), path.join(work, 'smoke-worker.mjs'));
  await cp(path.join(root, 'tests/integration/marionette.mjs'), path.join(work, 'marionette.mjs'));
  await cp(path.join(root, 'tests/integration/probe'), path.join(work, 'probe'), { recursive: true });
  // Exercise the exact release modules, not separate copies of their algorithms.
  for (const name of ['compose', 'move']) {
    const extracted = spawnSync('unzip', ['-oq', path.join(work, `${name}.xpi`), 'extensions/*', 'shared/*', '-d', path.join(work, 'probe')], {encoding:'utf8'});
    if (extracted.error || extracted.status !== 0) throw new Error('Could not extract production modules for isolated probe.');
  }
  const prefs = {
    'marionette.port': 2828, 'marionette.enabled': true,
    'mail.provider.suppress_dialog_on_startup': true, 'mail.shell.checkDefaultClient': false,
    'mail.startup.enabledMailCheckOnce': false, 'mailnews.start_page.enabled': false,
    'browser.aboutwelcome.enabled': false, 'app.update.auto': false, 'app.update.enabled': false,
    'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false,
    'mail.spotlight.firstRunDone': true, 'mailnews.database.global.indexer.enabled': false,
  };
  await writeFile(path.join(work, 'profile/user.js'), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
  // Fail closed: never fall back to unsandboxed Thunderbird or an existing instance.
  const result = spawnSync('bwrap', sandboxArguments(work, process.execPath, process.env.THUNDERBIRD || '/usr/bin/thunderbird'), {
    stdio: 'inherit', timeout: 150_000, killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Isolated smoke failed (exit ${result.status}); inspect ${work}/result.json and thunderbird.log`);
  const report = JSON.parse(await readFile(path.join(work, 'result.json'), 'utf8'));
  if (!report.ok) throw new Error('Smoke did not produce a passing report');
  console.log(`PASS: synthetic API smoke only. Evidence: ${work}/result.json`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
