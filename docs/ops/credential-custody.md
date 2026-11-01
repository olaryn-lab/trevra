# Credential custody policy (TRV-010)

Owner-approved on 2026-11-01: Nango for provider OAuth, the AES-GCM custody
store for workspace-entered secrets with its server key in OpenBao, a 90-day
server-key rotation, and owner-only access to backups and secrets.

## Where each credential lives

| Credential                                                                                                                                                                                 | Home                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider OAuth (Gmail, Microsoft 365, CRMs, other Nango integrations)                                                                                                                      | Nango. Trevra keeps connection ids, never refresh tokens, and does not rebuild OAuth or token rotation.                                                                                                                                 |
| Workspace-entered secrets: model API keys, LinkedIn/Reddit account credentials, seat proxy credentials, capture-source secrets, provider webhook secrets, outbound webhook signing secrets | The custody store in PostgreSQL (`src/server/secrets/crypto.ts`): AES-256-GCM, a per-workspace HKDF data key, and the row's identity as authenticated data, so a sealed value opens only in the row it was written to.                  |
| The server key `TREVRA_SECRETS_KEY`                                                                                                                                                        | OpenBao KV v2 at `kv/data/production/trevra/runtime/TREVRA_SECRETS_KEY`. The `production-trevra-reader` AppRole reads it at release through `infra/oracle/openbao-env.py`, which writes the host's mode-0600 `/opt/trevra/.env.oracle`. |

The server key is never committed, baked into an image, sent to a browser, or
logged. The other server runtime secrets follow the same OpenBao path
(`infra/oracle/OPENBAO.md`).

## What this protects, and what it does not

A database dump or backup on its own opens nothing. The key plus the database
opens every workspace's secrets: the per-workspace keys are derived from the
one server key, so this is not per-tenant key custody and must not be
described as such. The upgrade path is a KMS or HSM that hands out per-workspace
keys Trevra can use but not read. `crypto.ts` is shaped so that upgrade changes
one function.

## 90-day server-key rotation

Rotate every 90 days. Rotate at once if the key, the host, the OpenBao reader
credentials, or a backup stored together with the key may have been exposed.

1. **Check the starting point.** Run the custody report (command in
   `src/server/secrets/custody.ts`). It must show no `unknown` rows.
2. **Stage the new key.** Generate it with `openssl rand -base64 32`. In
   OpenBao, write the current value to `.../runtime/TREVRA_SECRETS_KEY_PREVIOUS`
   and the new value to `.../runtime/TREVRA_SECRETS_KEY`, using the same
   envelope as the other runtime keys. The reader policy must allow the
   `TREVRA_SECRETS_KEY_PREVIOUS` path; that is a one-time OpenBao policy change
   by the owner.
3. **Deploy both keys.** On the host, give `TREVRA_SECRETS_KEY_PREVIOUS` a
   non-empty placeholder in `.env.oracle` (the script fetches only keys the file
   already has), run `openbao-env.py --apply` and then `--check`, and recreate
   the API and worker. Existing rows still open with the previous key, and every
   new write uses the new key.
4. **Re-encrypt.** Run `resealSecrets` until `secretsCustodyReport` returns
   `complete: true`. That report is the only allowed basis for the next step.
   Since 2026-11-01 it also covers outbound webhook signing secrets, including a
   live overlap secret.
5. **Retire the old key.** Set `TREVRA_SECRETS_KEY_PREVIOUS=` (empty) in
   `.env.oracle`, recreate the API and worker, and check health. Keep the old
   key in OpenBao until the last backup that needs it has aged out. Pre-deploy
   backups are kept 14 days. Then delete that OpenBao entry.
6. **Record it.** Log the date and the old and new `currentKeyId` values from
   the report. These are fingerprints, not key material.

Known limits:

- On a hosted deployment the re-encrypt pass refuses LinkedIn and Reddit
  account credentials by design. Those rows stay on the previous key and keep
  the report incomplete. Do not retire the old key while any remain. The
  workspace owner must delete and re-enter them first.
- Stored LinkedIn browser sessions are not re-encrypted. After the old key is
  retired they fall back to "needs re-login".
- The protected rollback copy `/opt/trevra/.env.oracle.pre-openbao` holds the
  key that was current at the OpenBao cutover. Keep it as AGENTS.md requires,
  and treat it as a backup under the access rule below.

## Access to backups and secrets

Only the owner may access:

- SSH to the Oracle host. It holds `.env.oracle`, `.openbao-approle.json` and
  `/mnt/data/backups`.
- OpenBao writes under `production/trevra/runtime/*`, and the owner GPG
  administrator identity.
- Nango administration.

No other person and no other service identity gets read access to backups or to
the server key. Pre-deploy backups are `pg_dump -Fc` files, mode 0600 in a 0700
directory on the attached volume, kept 14 days. They hold ciphertext only.
Never copy a backup and the server key to the same place off the host.

The OpenBao AppRole secret ID is bounded and renewed by
`infra/oracle/rotate-app-approle.py` (see `OPENBAO.md` for its activation
status).
