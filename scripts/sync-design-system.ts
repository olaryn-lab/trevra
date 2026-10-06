/**
 * Vendors the shared Leanchain design system into Trevra.
 *
 *   npx tsx scripts/sync-design-system.ts <path-to-leanchain/design-system>
 *
 * Writes public/design-system.css (the self-hosted font faces Trevra's roles
 * name, then the resolved Trevra roles from dist/css/trevra.css) and copies
 * those families' files and OFL licences into public/fonts. Every page links
 * /design-system.css before its own sheet, and the --t-* token layer in
 * styles.css and marketing.css reads these roles.
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

const roles = (await readFile(brandCss, 'utf8')).replace(/^\/\*[\s\S]*?\*\/\n+/, '');

// fonts.css carries every product's faces (Beseam's Lora among them); vendor only
// the families Trevra's roles actually name, so no unused face or file ships.
const allFaces = (await readFile(fontsCss, 'utf8'))
  .replace(/^\/\*[\s\S]*?\*\/\n+/gm, '')
  .match(/@font-face\s*\{[^}]*\}/g);
// Every face is either a self-hosted file under ../fonts/ or a local() metric fallback.
const sourced = (face: string) => face.includes('url("../fonts/') || /src:\s*local\(/.test(face);
if (!allFaces?.some((face) => face.includes('url("../fonts/')) || !allFaces.every(sourced)) {
  throw new Error(
    'sync-design-system: fonts.css faces no longer point at ../fonts/ or local(); update this script'
  );
}
const familyOf = (face: string) => /font-family:\s*"([^"]+)"/.exec(face)?.[1] ?? '';
const kept = allFaces.filter((face) => roles.includes(`"${familyOf(face)}"`));
const families = new Set(kept.map(familyOf));
if (families.size === 0) {
  throw new Error(
    'sync-design-system: dist/css/trevra.css names none of the families in fonts.css'
  );
}
const faces = kept.join('\n').replaceAll('url("../fonts/', 'url("/fonts/');
const fontFiles = [...faces.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
const hosted = [...new Set(kept.filter((face) => face.includes('url("../fonts/')).map(familyOf))];
const licences = hosted.map((family) => `OFL-${family.replaceAll(' ', '')}.txt`);

const header = `/* Vendored from leanchain/design-system@${commit} by scripts/sync-design-system.ts.
   Do not edit by hand: change the design system, then re-run the script.
   Fonts are served from /fonts (${hosted.join(', ')}; OFL). */\n\n`;
await writeFile(
  resolve('public/design-system.css'),
  `${header}${faces.trim()}\n\n${roles.trim()}\n`
);

await mkdir(resolve('public/fonts'), { recursive: true });
const available = new Set(await readdir(fontsDir));
const files = [...new Set([...fontFiles, ...licences])];
const missing = files.filter((name) => !available.has(name));
if (missing.length > 0) {
  throw new Error(`sync-design-system: ${fontsDir} is missing ${missing.join(', ')}`);
}
for (const name of files) await copyFile(join(fontsDir, name), resolve('public/fonts', name));

console.log(
  `Vendored design-system@${commit}: public/design-system.css and ${files.length} file(s) in public/fonts`
);
