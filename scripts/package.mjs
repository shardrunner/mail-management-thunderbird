import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const EXTENSIONS = ['compose'];

// An XPI holds LICENSE, shared/ and its own extension folder; Markdown notes stay out.
async function releaseFiles(root, name) {
  const files = async dir => (await readdir(path.join(root, dir), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && !entry.name.endsWith('.md'))
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)));
  return ['LICENSE', ...await files('shared'), ...await files(`extensions/${name}`)].sort();
}

export async function buildPackages({ root = fileURLToPath(new URL('../', import.meta.url)), outDir = path.join(root, 'dist') } = {}) {
  outDir = path.resolve(outDir);
  await mkdir(outDir, { recursive: true });
  const outputs = [];
  for (const name of EXTENSIONS) {
    const stage = await mkdtemp(path.join(tmpdir(), `${name}-xpi-`));
    try {
      for (const file of await releaseFiles(root, name)) {
        // Thunderbird expects the manifest at the archive root.
        const target = path.join(stage, file === `extensions/${name}/manifest.json` ? 'manifest.json' : file);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(root, file), target);
      }
      const output = path.join(outDir, `${name}.xpi`);
      await rm(output, { force: true });
      execFileSync('zip', ['-q', '-r', '-X', '-D', output, '.'], { cwd: stage });
      outputs.push(output);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  return outputs;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const output of await buildPackages()) console.log(output);
}
