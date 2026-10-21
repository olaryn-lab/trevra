import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCycloneDx } from './check-parity-release.js';

export type SbomRunner = () => {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: Error;
};

const npmSbom: SbomRunner = () =>
  spawnSync('npm', ['sbom', '--sbom-format', 'cyclonedx'], {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024
  });

/** A missing/invalid inventory must NEVER leave a previously published SBOM behind. */
export async function buildFreshSbom(
  destination: string,
  run: SbomRunner = npmSbom
): Promise<{ published: boolean; reason?: string }> {
  await rm(destination, { force: true });
  let result: ReturnType<SbomRunner>;
  try {
    result = run();
  } catch (error) {
    return { published: false, reason: error instanceof Error ? error.message : 'Runner failed' };
  }
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || 'npm sbom exited unsuccessfully')
      .trim()
      .split('\n')
      .slice(0, 2)
      .join('; ');
    return { published: false, reason: `npm sbom exit ${result.status ?? 'unknown'}: ${detail}` };
  }
  let inventory: unknown;
  try {
    inventory = JSON.parse(result.stdout);
  } catch {
    return { published: false, reason: 'npm sbom produced invalid JSON' };
  }
  const invalid = validateCycloneDx(inventory);
  if (invalid) return { published: false, reason: invalid };

  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { published: true };
}

async function main() {
  const destination = resolve('public/catalog/trevra.sbom.cdx.json');
  const result = await buildFreshSbom(destination);
  if (result.published) {
    console.log(
      'Published freshly generated CycloneDX inventory. This is not release certification.'
    );
  } else {
    console.warn(`SBOM UNAVAILABLE — no dependency inventory published: ${result.reason}`);
    console.warn('Development build only. Release certification remains fail-closed.');
    if (process.argv.includes('--strict')) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
