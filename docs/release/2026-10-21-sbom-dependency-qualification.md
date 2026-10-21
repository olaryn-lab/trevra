# Trevra dependency inventory: reproducibility investigation

**Date:** 2026-10-21

**Status:** **BLOCKED — not release-qualified**

## Reproduced observations

The Dripify-parity worktree currently uses a symlinked `node_modules` directory pointing to the main Trevra checkout, rather than its own clean lockfile install. The lockfile is v3 with 683 package entries. This is sufficient to run the repository's development tests, **not** evidence of a reproducible production dependency tree.

- `npm sbom --sbom-format cyclonedx` fails with `ESBOMPROBLEMS` (numerous missing/invalid peer and development dependencies from the shared installation). The strict release gate correctly fails rather than reusing a committed catalog SBOM.
- `npm sbom --sbom-format cyclonedx --omit=dev` also fails against the existing installation.
- An offline, no-script, package-lock-only npm install in `/tmp/trevra-sbom-lock-probe-20261021` returned exit 0 but did not change the lock. `npm sbom --package-lock-only --sbom-format cyclonedx` then still failed: missing `@emnapi/runtime@^1.11.3` required by optional `@img/sharp-wasm32@0.35.4`, and missing peer `@emnapi/core@^1.7.1` and `@emnapi/runtime@^1.7.1` required by optional `@napi-rs/wasm-runtime@1.1.6`.
- `npm sbom --package-lock-only --omit=optional --sbom-format cyclonedx` succeeded and enumerated **526 components**. **This deliberately omits optional packages**, including potentially platform-relevant packages, and must not be substituted for a full inventory or release gate. An absent component under that command is not proof that an application does not need it.

## Required operator remediation and proof

1. Record the supported production runtime (Node and npm versions, OS/architecture and image digest). Freeze `package.json` and `package-lock.json` for the qualification run; do **not** use the shared main-checkout `node_modules`.
2. In a new, disposable isolated environment, run `npm ci` with lock integrity checks and install hooks reviewed for supply-chain safety; include runtime-required optional platform packages. If installation fails or lock-only SBOM remains invalid, resolve the missing optional/peer dependency graph **in the lockfile with a reviewed dependency update**, not by fabricating SBOM entries or declaring the omission safe.
3. From that exact qualified installation, run `npm ls --all` and `npm sbom --sbom-format cyclonedx` with no ignored/omitted dependency classes. Record the exit status, generated SBOM component count, npm/Node versions, lockfile SHA-256, container image digest, and reviewed vulnerability/license scan outcome.
4. Re-run `npm run check` and the strict `npm run release:certify` on the same dependency tree. Keep the strict gate failing on unverified capabilities, no approved distribution license, legal/provider decisions and missing operational smoke. Do not treat an SBOM-only fix as permission to deploy.
5. Archive redacted evidence, reviewer/approver identities and UTC timestamps. No customer secrets or access tokens in reports.

**Decision:** The underlying package tree and optional WASM dependencies require explicit resolution/qualification. Neither successful builds against the shared node_modules nor a partial `--omit=optional` inventory closes the supply-chain gate. No dependency graph mutation, production install or deployment was attempted as part of this investigation.
