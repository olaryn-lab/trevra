/** Fail-closed production-release certification for the Dripify parity plan.
 * `npm run check` is a development/test gate, not permission to ship.
 * No remote providers, databases, services or deployment APIs are accessed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PLAN = 'docs/planning/2026-10-20-dripify-parity-execution-plan.md';

export interface ParityReleaseEvidence {
  registry: Map<string, string>;
  ledger: Map<string, string>;
  blockers: string[];
}

export function evaluateParityRelease(plan: string, hasLicense: boolean): ParityReleaseEvidence {
  const registry = new Map<string, string>();
  const ledger = new Map<string, string>();
  const blockers: string[] = [];
  const [beforeRegistry, fromRegistry = ''] = plan.split(
    '## Full Dripify capability parity registry'
  );
  const registryTable = fromRegistry.split(/\n## |\n### /)[0];
  for (const line of beforeRegistry.split('\n')) {
    if (!/^\| TRV-\d{3} \|/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (ledger.has(cells[0])) blockers.push(`Duplicate P0 ledger task: ${cells[0]}`);
    ledger.set(cells[0], cells[2]);
  }
  for (const line of registryTable.split('\n')) {
    if (!/^\| TRV-\d{3} \|/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (registry.has(cells[0])) blockers.push(`Duplicate capability: ${cells[0]}`);
    registry.set(cells[0], cells[5]);
  }
  for (let n = 1; n <= 11; n++) {
    const id = `TRV-${String(n).padStart(3, '0')}`;
    if (ledger.get(id) !== 'VERIFIED') blockers.push(`${id}: ${ledger.get(id) ?? 'MISSING'} (P0)`);
  }
  for (let n = 12; n <= 57; n++) {
    const id = `TRV-${String(n).padStart(3, '0')}`;
    if (registry.get(id) !== 'VERIFIED')
      blockers.push(`${id}: ${registry.get(id) ?? 'MISSING'} (capability)`);
  }
  if (registry.size !== 46) blockers.push(`Expected 46 capability rows; found ${registry.size}`);
  if (ledger.size !== 11) blockers.push(`Expected 11 P0 ledger rows; found ${ledger.size}`);
  if (!hasLicense)
    blockers.push('No owner-approved software distribution license (LICENSE/COPYING).');
  return { registry, ledger, blockers };
}

export function validateCycloneDx(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'SBOM is not an object';
  const bom = value as Record<string, unknown>;
  if (bom.bomFormat !== 'CycloneDX') return 'SBOM must be CycloneDX';
  if (typeof bom.specVersion !== 'string' || !/^1\.[4-9]$/.test(bom.specVersion))
    return 'SBOM version is missing or unsupported';
  if (!Array.isArray(bom.components) || bom.components.length === 0)
    return 'SBOM is missing dependency components';
  if (!bom.metadata || typeof bom.metadata !== 'object') return 'SBOM is missing metadata';
  return null;
}

function checkRelease(): number {
  const plan = readFileSync(resolve(PLAN), 'utf8');
  const evidence = evaluateParityRelease(
    plan,
    ['LICENSE', 'LICENSE.md', 'COPYING', 'COPYING.md'].some((file) => existsSync(resolve(file)))
  );
  const blockers = [...evidence.blockers];
  // Strictly generate a new dependency inventory from the current installation.
  // A stale checked-in CycloneDX file is NOT evidence that the current build is safe.
  const sbom = spawnSync('npm', ['sbom', '--sbom-format', 'cyclonedx'], {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (sbom.error || sbom.status !== 0) {
    blockers.push(
      `Fresh npm SBOM generation failed (exit ${sbom.status ?? 'unknown'}): ${(
        sbom.stderr ??
        sbom.error?.message ??
        ''
      )
        .trim()
        .split('\n')
        .slice(0, 3)
        .join('; ')}`
    );
  } else {
    try {
      const error = validateCycloneDx(JSON.parse(sbom.stdout));
      if (error) blockers.push(error);
    } catch {
      blockers.push('Fresh SBOM output is not valid JSON');
    }
  }
  console.log(
    `Release certification: ${evidence.registry.size} capabilities, ${evidence.ledger.size} P0 ledger entries, ${blockers.length} blockers.`
  );
  if (blockers.length) {
    console.error(blockers.join('\n'));
    console.error('NOT RELEASE CERTIFIED: do not deploy or market as full Dripify parity.');
    return 1;
  }
  console.log(
    'Static release assertions passed. Live-provider, security, privacy and deployment acceptance still require separately recorded evidence.'
  );
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href)
  process.exitCode = checkRelease();
