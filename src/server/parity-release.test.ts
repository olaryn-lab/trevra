import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFreshSbom } from '../../scripts/build-sbom.js';
import { evaluateParityRelease, validateCycloneDx } from '../../scripts/check-parity-release.js';

const verifiedPlan = () => `
## Current defect ledger (start here)
${Array.from(
  { length: 11 },
  (_, index) => `| TRV-${String(index + 1).padStart(3, '0')} | P0 | VERIFIED | qualified |`
).join('\n')}
## Full Dripify capability parity registry
| ID | Area | End state | Gap | Priority | Verification |
${Array.from(
  { length: 46 },
  (_, index) =>
    `| TRV-${String(index + 12).padStart(3, '0')} | Capability | qualified | none | P0 | VERIFIED |`
).join('\n')}
## Handoff checklist
`;

describe('production parity release assertions', () => {
  it('requires all 57 distinct ledger/capability tasks and a real distribution license', () => {
    const complete = evaluateParityRelease(verifiedPlan(), true);
    expect(complete.registry.size).toBe(46);
    expect(complete.ledger.size).toBe(11);
    expect(complete.blockers).toEqual([]);
    const missingApproval = evaluateParityRelease(
      verifiedPlan()
        .replace('| TRV-009 | P0 | VERIFIED |', '| TRV-009 | P0 | IN PROGRESS |')
        .replace(
          '| TRV-033 | Capability | qualified | none | P0 | VERIFIED |',
          '| TRV-033 | Capability | qualified | none | P0 | UNVERIFIED |'
        ),
      false
    );
    expect(missingApproval.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('TRV-009'),
        expect.stringContaining('TRV-033'),
        expect.stringContaining('license')
      ])
    );
  });

  it('refuses missing, duplicate and fabricated registry rows', () => {
    const duplicate = evaluateParityRelease(
      verifiedPlan().replace(
        '## Handoff checklist',
        '| TRV-012 | Capability | qualified | none | P0 | VERIFIED |\n## Handoff checklist'
      ),
      true
    );
    expect(duplicate.blockers).toContain('Duplicate capability: TRV-012');
    const missing = evaluateParityRelease(
      verifiedPlan().replace('| TRV-057 | Capability | qualified | none | P0 | VERIFIED |', ''),
      true
    );
    expect(missing.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('TRV-057: MISSING'),
        expect.stringContaining('Expected 46 capability rows')
      ])
    );
  });

  it('never certifies stale or empty SBOM metadata as a dependency graph', () => {
    expect(validateCycloneDx(null)).toMatch(/not an object/);
    expect(
      validateCycloneDx({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [] })
    ).toMatch(/missing dependency components/);
    expect(
      validateCycloneDx({
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        components: [{ name: 'some-package' }],
        metadata: { timestamp: '2026-10-21' }
      })
    ).toBeNull();
  });

  it('does not claim a verified built-in catalog SBOM when the build allows SBOM generation failures', () => {
    const generator = readFileSync('scripts/build-public-catalog.ts', 'utf8');
    expect(generator).toContain('trust: { signed: false, sbom: false, verifiedRelease: true }');
  });

  it('removes a stale published inventory on npm SBOM failure without substituting a partial one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trevra-sbom-fail-'));
    const output = join(directory, 'catalog', 'trevra.sbom.cdx.json');
    try {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(directory, 'catalog')));
      await writeFile(output, '{"old":"unqualified"}');
      const result = await buildFreshSbom(output, () => ({
        status: 1,
        stdout: '',
        stderr: 'ESBOMPROBLEMS: missing optional dependencies'
      }));
      expect(result).toMatchObject({ published: false });
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('only publishes a newly generated, parseable CycloneDX dependency graph', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'trevra-sbom-valid-'));
    const output = join(directory, 'catalog', 'trevra.sbom.cdx.json');
    try {
      const invalid = await buildFreshSbom(output, () => ({ status: 0, stdout: '{' }));
      expect(invalid.reason).toMatch(/invalid JSON/);
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const bom = {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        metadata: { timestamp: '2026-10-21T00:00:00Z' },
        components: [{ type: 'library', name: 'example-dependency', version: '1.0.0' }]
      };
      expect(
        await buildFreshSbom(output, () => ({ status: 0, stdout: JSON.stringify(bom) }))
      ).toEqual({ published: true });
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(bom);
      const rejected = await buildFreshSbom(output, () => ({
        status: 0,
        stdout: JSON.stringify({ bomFormat: 'CycloneDX', components: [] })
      }));
      expect(rejected.published).toBe(false);
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports current repository capabilities as blocked rather than production-ready', () => {
    const plan = readFileSync('docs/planning/2026-10-20-dripify-parity-execution-plan.md', 'utf8');
    const actual = evaluateParityRelease(plan, false);
    expect(actual.registry.size).toBe(46);
    expect(actual.ledger.size).toBe(11);
    expect(actual.blockers.length).toBeGreaterThan(0);
    expect(actual.blockers.some((blocker) => blocker.includes('TRV-004'))).toBe(true);
    expect(actual.blockers.some((blocker) => blocker.includes('TRV-051'))).toBe(true);
  });
});
