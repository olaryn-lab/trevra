# Trevra UI worktree consolidation — 2026-10-21

Base: c7a012bd41d9ab8d431d45afff45061c5e32e9be
Integration branch: integration/trevra-shell-cleanup-20261021

## What is integrated

From feat/saas-shell-alignment-20261021, **selected, not merged wholesale**:

- Compact sidebar padding (16px / 12px), 2px navigation gaps, active navigation emphasis using existing Trevra green.
- Maintain the 228px sidebar rather than expand it to 248px, and make the second layout track minmax(0, 1fr) to avoid an unwanted content minimum.
- Desktop main horizontal spacing at 32px and 64px bordered topbar.
- 390px mobile layout with 16px content inset and 18px topbar vertical inset, retaining the mobile tabbar and bottom safe area.
- Live Chromium desktop/mobile computed-style checks in the existing reproducible launch acceptance command, plus a focused static UI contract test.

## Explicitly not integrated

- Obsolete pill-shaped button, icon-button and navigation-control overrides from the original SaaS-shell worktree. Keep current control radius 6px, panel radius 12px, and 1px focus edge.
- The large feat/shared-design-system branch: it replaces Trevra's current font policy, colors, CSS tokens, radius values, public HTML/marketing styles, and build/font synchronization rules. Its panel contract uses 8px, while current main uses 12px. A separate coordinated decision across the Olaryn applications is needed before adopting it. It is **preserved as a Git branch** for later review, not merged or represented as deployed.
- No staging/production deployment, secret changes, credential use or provider outreach.

## Reproducible qualification

    npx vitest run src/client/ui/saas-shell.contract.test.ts
    npm run launch:acceptance
    npm run check

Local browser checks cover actual authenticated Trevra React and CSS computed layout at 1280px desktop and 390px mobile, not only CSS regex assertions. The launch suite uses disposable PostgreSQL and provider doubles.

Run logs:

- /tmp/trevra-shell-focused.log
- /tmp/trevra-shell-launch.log
- /tmp/trevra-shell-fullcheck.log

## Worktree cleanup

Already folded but modified generated catalog worktrees (login-parity-v3, dripify-parity, authward-confidential-live) were backed up with per-file SHA-256 checks before removal; the original branches remain. Preservation files: /home/pankaj/Projects/Trevra-cleanup-preserved-20261021/folded-worktrees.

The main worktree's uncommitted reports, generated files, local prod.db, other user work and stashes remain unchanged. An actively used gtm-integrations worktree must not be removed while the process has its cwd there.
