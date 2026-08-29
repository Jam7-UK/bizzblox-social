# BizzBLOX managed-service boundary

This public AGPL repository owns provider mechanics only: provider OAuth,
account selection, live settings/helper contracts, media delivery, token
refresh, idempotent publication mechanics, cancellation, and provider metrics.

BizzBLOX remains a separate HTTPS/queue client and owns WorkOS identity,
exact-workspace membership, approvals, immutable AMP card versions, scheduling
intent, customer settings, agent policy, audit, HubSpot attribution, and every
customer-facing AMP screen. No proprietary BizzBLOX package, source repository,
customer UI, card movement rule, or workspace authority may be imported into
this tree.

## Runtime contract

- One opaque BizzBLOX tenant handle maps to one Postiz organization and one
  independently rotatable tenant credential.
- Internal requests require API Gateway IAM context, a short-lived one-use
  Integration V3 claim, and the exact tenant credential.
- The service accepts stable opaque publication/channel/helper references. It
  never accepts a caller-selected BizzBLOX workspace, organization, service
  tenant, API origin, or callback URL as authority.
- Public ingress is limited to `GET /health` and the fixed provider callback at
  `/oauth/bizzblox/callback/:provider`. The internal contract lives below
  `/internal/bizzblox/v1/*`; login, registration, dashboard, billing,
  marketplace, generic public API, MCP, and AI routes return a generic 404 in
  service mode.
- Provider credentials remain inside the exact service tenant. Credentials,
  signed claims, content bodies, remote IDs, and service tenancy never appear
  in browser/model responses, logs, metrics, traces, or queue messages.

`BIZZBLOX_SERVICE_MODE=1` is production-only. Development and BizzBLOX's
current pre-production stage must use deterministic fakes and cannot call the
production data plane. Deployment and exact-workspace connector activation are
separate operations.
