/**
 * Vendors the shared Leanchain design system into Trevra.
 *
 *   npx tsx scripts/sync-design-system.ts <path-to-leanchain/design-system>
 *
 * Writes public/design-system.css (the self-hosted font faces, then the
 * resolved Trevra roles from dist/css/trevra.css) and copies dist/fonts into
 * public/fonts. Every page links /design-system.css before its own sheet, and
 * the --t-* token layer in styles.css and marketing.css reads these roles.
 * Re-run after the design system changes; never edit the outputs by hand.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = process.argv[2] ?? process.env.LEANCHAIN_DESIGN_SYSTEM;
if (!source) {
  throw new Error(
    'sync-design-system: pass the path to a leanchain/design-system checkout (or set LEANCHAIN_DESIGN_SYSTEM)'
  );
}
const root = resolve(source);
const fontsCss = join(root, 'dist/css/fonts.css');
const brandCss = join(root, 'dist/css/trevra.css');
const fontsDir = join(root, 'dist/fonts');
for (const path of [fontsCss, brandCss, fontsDir]) {
  if (!existsSync(path)) {
    throw new Error(`sync-design-system: ${path} not found -- run \`bun run build\` in ${root}`);
  }
}

const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8'
}).trim();
const dirty =
  execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'dist'], {
    encoding: 'utf8'
  }).trim() !== '';
if (dirty) {
  throw new Error(
    `sync-design-system: ${root}/dist has uncommitted changes; commit them so the vendored copy names a real version`
  );
}

const faces = (await readFile(fontsCss, 'utf8'))
  .replace(/^\/\*[\s\S]*?\*\/\n+/gm, '')
  .replaceAll('url("../fonts/', 'url("/fonts/');
if (!faces.includes('url("/fonts/')) {
  throw new Error(
    'sync-design-system: fonts.css no longer points at ../fonts/; update this script'
  );
}
const roles = (await readFile(brandCss, 'utf8')).replace(/^\/\*[\s\S]*?\*\/\n+/, '');

const header = `/* Vendored from leanchain/design-system@${commit} by scripts/sync-design-system.ts.
   Do not edit by hand: change the design system, then re-run the script.
   Fonts are served from /fonts (Instrument Sans and Fira Code, OFL). */\n\n`;
await writeFile(
  resolve('public/design-system.css'),
  `${header}${faces.trim()}\n\n${roles.trim()}\n`
);

await mkdir(resolve('public/fonts'), { recursive: true });
const files = (await readdir(fontsDir)).filter((name) => /\.(woff2|txt)$/.test(name));
for (const name of files) await copyFile(join(fontsDir, name), resolve('public/fonts', name));

console.log(
  `Vendored design-system@${commit}: public/design-system.css and ${files.length} file(s) in public/fonts`
);
