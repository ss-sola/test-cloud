import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const loadPackage = createRequire(import.meta.url);
const x6Directory = path.dirname(loadPackage.resolve('@antv/x6/package.json'));
const license = await readFile(path.join(x6Directory, 'LICENSE'), 'utf8');

await build({
  entryPoints: [path.join(directory, 'workflow-graph.entry.mjs')],
  outfile: path.join(directory, '../public/vendor/workflow-graph.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  mainFields: ['module', 'main'],
  minify: true,
  legalComments: 'eof',
  banner: { js: `/*! @antv/x6\n${license}\n*/\nif (typeof document !== 'undefined') {` },
  footer: { js: '}' },
});
