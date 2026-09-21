# BizzBLOX managed social service operations

This repository is the public AGPL provider runtime. AMP/Convex remains the
control plane. Production is one dedicated, multi-AZ service in `eu-west-2`;
AMP development, pre-production and production use separate environment-bound
claims and exact-workspace tenants in this shared service. Customer credentials,
provider connections and account ownership must never cross those boundaries.

## Production profile

`BIZZBLOX_SERVICE_MODE=1` installs a deny-by-default route policy. Only bounded
`GET /health`, the fixed provider OAuth callback, and the closed
`/internal/bizzblox/v1/*` method/path set are reachable. Generic Postiz login,
registration, dashboard, billing, marketplace, public API, MCP, and AI routes
return a generic 404 even though upstream modules remain available to the
provider implementation internally.

The API requires:

- exact API Gateway IAM context from the BizzBLOX bridge role;
- a short-lived one-use Integration V3 operation claim;
- an exact tenant credential bound to the same service organization; and
- fixed `https://social.bizzblox.com` and AMP return origins.

AWS injects platform secrets through ECS task-definition `secrets`. The
application uses task-role credentials for an exact `managed-media/` S3 prefix;
objects are private, checksum-bound, SSE-KMS encrypted with object/purpose
context, and exposed only through short-lived exact-object reads. Do not add
static AWS credentials, public ACLs, bucket-list permission, customer tokens,
or a local-disk production fallback.

Provider access and refresh tokens are stored only as versioned
`bizzblox.kms.v1` envelopes. The runtime requests an AES-256 data key from KMS,
uses AES-GCM locally, and binds both KMS encryption context and GCM additional
authenticated data to the exact service organization, integration row, token
purpose, and key version. Ordinary integration reads remain sealed. Only the
provider execution and refresh methods open them, and those methods run inside
an API request or Temporal activity so clear tokens never enter workflow input,
result, search attributes, or history.

Token-root rotation is additive and read-old/write-current:

1. Add the previous version and ARN to
   `BIZZBLOX_TOKEN_KMS_PREVIOUS_KEYS`; retain its decrypt permission.
2. Set `BIZZBLOX_TOKEN_KMS_KEY_ARN` and
   `BIZZBLOX_TOKEN_KEY_VERSION` to the new reviewed root/version.
3. Deploy and prove an old envelope reads while every refreshed or reconnected
   token is written with the current version.
4. Retire an old key only after provider-token inventory proves no envelope
   references that version and the rollback window has closed.

Never reuse a version for another key, remove an old mapping before migration,
or place provider tokens or plaintext data keys in environment variables.

## Reproducible build

```bash
pnpm install --frozen-lockfile
pnpm source:check
pnpm test
pnpm build:backend
pnpm build:orchestrator
docker build --file Dockerfile.production --target api \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag bizzblox-social-api:test .
docker build --file Dockerfile.production --target orchestrator \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  --tag bizzblox-social-orchestrator:test .
```

Production ECR repositories accept immutable digests only. Before promotion,
verify OCI source/revision/licence labels, the public corresponding-source
archive checksum, tests, SBOM, vulnerability review, and the BizzBLOX change
packet. Never promote a mutable tag or a revision absent from the public repo.

## Failure and recovery

- Fence new dispatch in AMP before rolling back a service digest. Preserve
  ambiguous publication rows for exact reconciliation; never retry under a new
  external publication id.
- A provider outage or refresh failure inactivates the affected exact channel;
  it never changes another tenant or the platform release result.
- Credential compromise requires tenant/provider revocation, additive KMS/key
  rotation, exact reconnect, and a redaction audit. Never print or copy the
  suspected value into a ticket, log, trace, Temporal attribute, or workflow.
- Drain SQS/DLQ through exact idempotency readback. Queue bodies contain opaque
  references only, never content or credentials.
- Database/S3 restore drills use an isolated, non-routable recovery target and
  must prove checksums, migrations, tenant isolation, RPO, and RTO before
  cleanup. Application rollback never deletes RDS, Redis evidence, S3, or KMS.

Live AWS identifiers, provider applications, legal/data approvals, security
contact, on-call owner, costs, and change window belong in the separately
approved production packet and provider readback. This source intentionally
does not invent them. Deployment and per-workspace Integration V3 activation
remain separate journaled operations.

## Provider account ownership

Each finalized provider account belongs to one managed service organization,
which maps to one AMP environment/workspace pair. The shared service does not
share that account's credentials, channels or publishing permission. Connection
admission reserves the provider namespace and authoritative external account ID
in `BizzbloxSocialAccountOwnership` under a serializable transaction and unique
key. A same-owner reconnect is allowed; a foreign owner is rejected before any
credential or final account identity is written. Identical IDs in different
provider namespaces remain different identities.

Intermediate OAuth consent identifies the administrator, who may manage several
different pages or companies. It does not claim that administrator as the final
social destination. Ownership is reserved when the final page/account is
selected. Provider migration checks both the old account and the new identity.
Token opening for finalized provider execution checks ownership again, so
conflicting pre-existing accounts cannot keep publishing or refreshing silently.
Conflicting rows and credentials are preserved for explicit reconciliation;
this code never disconnects, deletes, reassigns or automatically replays them.
Ownership reservations remain after failed connects and disconnects. Ordinary
reconnect is not an account transfer.

The guarantee is bounded by the authoritative provider namespace and account ID.
Some alternate login methods issue app-scoped IDs for the same real-world
profile. This change does not infer equivalence from display names, credentials
or unsupported aliases. Cross-app identity correlation and live account inventory
must be proved separately before claiming universal external-account exclusivity.
Use distinct provider accounts for development, pre-production and production
acceptance; never copy a production grant into another tenant.

### Schema rollout and rollback

The new ownership table retains its owner relationship. The integration unique
key changes from `(organizationId, internalId)` to
`(organizationId, providerIdentifier, internalId)`. Although the ownership table
is additive, the unique-key replacement is not compatible with old writers.
The generated patch is `scripts/migrations/20260921-social-account-ownership.sql`,
derived from source revision `d3e1942aa8fe85b58b14459ecf5f2bf80f64351c`.
A disposable original-schema rehearsal preserved every field of two legacy
conflicting integration rows without assigning an arbitrary owner. Prepare and
review the Prisma schema diff against the exact deployed schema,
back up the database, and rehearse it on an isolated restored copy. Do not use
`--accept-data-loss` to bypass a warning.

Quiesce API and orchestrator provider work together, account for in-flight and
ambiguous provider operations, apply the reviewed schema change, and start the
matching API/orchestrator revision before reopening traffic. The approved operator applies the reviewed artifact
through `pnpm exec prisma db execute --file scripts/migrations/20260921-social-account-ownership.sql
--schema libraries/nestjs-libraries/src/database/prisma/schema.prisma`, with the
separately authorized exact database target. This is a deployment prerequisite,
not a command for an agent to run against a hosted database during source work.
The ordinary managed schema runner retains its warning refusal. A rolling mixture
of old writers and the new index is unsafe. Existing single-owner accounts are
claimed on first use; conflicting active final accounts fail closed pending
explicit reconciliation. No automatic backfill selects an arbitrary winner.

Before a rollback to old code, prove the old `(organizationId, internalId)`
uniqueness can be restored: the new schema permits equal IDs from different
providers in one organization. If such pairs exist, stop and prepare a forward
repair; do not delete accounts to restore an index. Retain the ownership ledger
and all ambiguous publication history. Reverting code without the ownership
fence reopens the defect and cannot certify isolated-account operation.

The focused `social-account-ownership.yml` workflow uses a disposable PostgreSQL
service. `SOCIAL_OWNERSHIP_TEST_DATABASE_URL` is a test-only override; never point
it at a hosted or customer database. Real database tests exercise concurrent
ownership, reconnect, namespaces, existing duplicates, account selection and
migration, in addition to the normal token-sealing tests.
