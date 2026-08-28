# BizzBLOX managed social service operations

This repository is the public AGPL provider runtime. AMP/Convex remains the
control plane. Production is one dedicated, multi-AZ service in `eu-west-2`;
development and BizzBLOX's current pre-production stage use fakes and must not
receive its credentials or call its data plane.

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
