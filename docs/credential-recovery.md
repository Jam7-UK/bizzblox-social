# Durable provider credential recovery

A failed refresh does not establish revoked consent. This runtime keeps recovery
state on the integration and preserves account identity, posts, settings and
lifecycle. Provider messages and credentials never appear in health responses.

## Health protocol

Each actual `/public/v1/integrations` summary and managed
`/internal/bizzblox/v1/channels` item carries:

```json
{
  "health": {
    "version": 1,
    "credentialGeneration": 0,
    "revision": 0,
    "state": "ready"
  }
}
```

The decoder accepts nonnegative safe integers and exactly these states:

| State               | Meaning                                                                   | Managed status |
| ------------------- | ------------------------------------------------------------------------- | -------------- |
| `ready`             | Current credentials are available                                         | `active`       |
| `recovering`        | A durable safe recovery path owns the next attempt                        | `disconnected` |
| `operator_required` | Platform configuration, uncertain exchange or unclassified legacy failure | `disconnected` |
| `consent_required`  | Exact refresh rejection with verified provider configuration              | `disconnected` |

An explicitly disabled integration is always `inactive`; deleted integrations
are omitted. The v1 wire has no reasons or timestamps. Older engines may omit
health. The decoder rejects malformed advertised health, and the directory
retains newer health when an older revision or legacy payload arrives.
`revision` increases across credential replacements, reconnects and health
changes; it never resets for a stable integration. Database counters use Prisma
`Int` and fail closed at the database limit rather than wrapping.

The directory is a cache. Provider execution opens current owner credentials
only after checking lifecycle, generation and health, then checks again after
opening the envelope. A stale active directory cannot authorize a held owner.

## Claim and exchange protocol

1. A serializable transaction claims the exact integration generation, revision,
   identity and lifecycle for ten minutes. One-time-token siblings share the claim.
   A competing caller cannot exchange the same credential.
2. Opening envelopes and checking platform configuration happens before exchange.
   Preparation failures retry safely. The owner durably records `exchanging`
   before calling the provider. Provider exchange paths do not use the generic
   HTTP retry wrapper.
3. A successful exchange is validated and sealed into pending access/refresh
   fields for every claimed sibling in one transaction. Tokens use the existing
   organization/integration/purpose envelope codec. This commit precedes profile
   selection/readback. Refresh does not rewrite names, account IDs or lifecycle.
   If profile recovery outlives the access token, the saved rotated refresh token
   becomes the next generation before another exchange is attempted.
4. Profile resolution uses the pending access token. Its failure retries that
   read, not the token exchange. Settlement checks the claim, unexpired lease,
   generation, revision, identity and lifecycle before installing credentials.
5. Reconnect, account selection, migration, sibling propagation, disable/delete,
   account retirement and tenant cleanup invalidate claims/generations. Late
   successes and failures cannot overwrite newer credentials or reactivate rows.

After lease expiry, a prepared or pending-profile attempt may recover. An
uncertain exchange is held unless its persisted provider policy proves replay
safe. The Google adapters declare stable refresh-token replay; all other adapters
default to no replay. The unsupported Dribbble refresh stub is held for configuration
repair; the previous Pinterest sandbox request is removed. Malformed token results are operator-held even for Google.
Profile errors cannot establish consent failure. Raw errors are caught at the
owner and replaced by enumerated internal reasons.

Google refresh uses its fixed token endpoint. Only an exact `invalid_grant`
HTTP 400 response from that POST can establish consent, and only if the saved
credential configuration fingerprint matches the current client ID, client secret
and scopes. Missing/unproven/mismatched configuration is operator-owned;
`invalid_client`, `unauthorized_client` and `invalid_scope` are configuration
failures. Generic 401s, message substrings and profile responses never establish
revocation. Legacy credentials without a fingerprint cannot establish consent.

Provider evidence:

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
  says to persist refresh tokens and continue using them while valid, including
  obtaining another access token at any time.
- [Google OAuth2Client](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/oauth2client.ts)
  preserves the original `refresh_token` in `refreshAccessTokenAsync`; this is also
  verified in the installed 9.x implementation. Profile reads are separate.
- [Temporal retry policy](https://typescript.temporal.io/api/interfaces/common.RetryPolicy)
  and [continueAsNew](https://typescript.temporal.io/api/namespaces/workflow#continueasnew)
  provide explicit activity attempts and bounded workflow histories.

## Durable scheduling and operator repair

New starts use `refreshTokenWorkflowV2`, never the immutable existing workflow.
Activities have `maximumAttempts: 1`; database claims own exchange replay, not
Temporal retries. A workflow waits 1 minute to 6 hours and continues as new after
100 cycles. Failed activities retry after a durable five-minute wait. Inputs and
results carry IDs, cursors and scheduling metadata only. Existing legacy
activities retain their signatures and sanitize pending credential fields too.

With `RUN_CRON` enabled, startup registers `refreshTokensSweepWorkflowV2`.
It pages 100 integrations at a time and continues as new every 50 pages, retaining
its cursor. This covers pre-existing channels and missed per-channel starts.
`refresh` uses the same owner and scans all pages. Every item is isolated so one
failure cannot stop the scan. Safe retries back off to six hours with no terminal
attempt ceiling. These timers and the startup registration require the existing
Temporal service and worker; the command alone is a one-shot scan.

The existing commands application exposes:

- `refresh-holds`: paged inventory of operator/consent/legacy holds containing IDs,
  counters, state and bounded reason only. It does not emit credentials or errors.
- `refresh-retry-configuration <organization> <integration> <generation> <revision>`:
  rechecks exact evidence and allows only a repaired configuration failure before
  exchange or a provider with persisted and current stable-token replay proof.
  Configuration fingerprints must still match when present. It queues recovery
  and reports `accepted`; it does not itself call a provider.

Unknown consumed rotating-token outcomes, legacy unclassified `refreshNeeded`,
and account-lineage mismatches must remain held. Investigate using provider-owned
evidence; add documented provider recovery semantics before permitting replay.
Do not clear a hold, infer nonconsumption from elapsed time, or ask the customer to
reconnect as a generic repair. Voluntary authorized fresh connection remains a
credential replacement, not an automatic retry. Restoring platform configuration
must use the original provider client lineage; switching clients is not repair.

## Migration and rollout

`scripts/migrations/20261111-durable-refresh.sql` is generated by Prisma schema
diff, following the existing standalone migration convention. It adds fields and
indexes only. It performs no provider operation or row backfill. Existing
`refreshNeeded` rows project operator-required at runtime even though the additive
health default is ready. Recovery inventory includes them explicitly.

Before an authorized rollout:

1. Deploy compatible optional health readers in managed clients. Older consumers
   must not interpret every disconnected result as a request for fresh consent.
2. Quiesce old credential writers and activities, then apply the additive artifact
   through the approved migration path. Mixed old/new writers cannot preserve the
   new generation fence. Never use an unreviewed `db push` on hosted data.
3. Start the new runtime with the existing cron registration enabled and verify
   the V2 sweep exists. Retain old workflow exports for replay compatibility.
4. Inspect bounded health/hold inventory and exact release revision before any
   separately authorized provider recovery.

Rollback retains schema, pending envelopes and holds. Quiesce new activities
before reverting code; do not run the old refresh writer against new held state.
An old reader may omit health, but an old writer cannot safely resume token work.
No hosted migration, deployment or provider operation is part of this change.

## Test value

- The managed reconnect regression fails before the fix because page resolution
  drops the newly authorized refresh token. It now retains the exchange lifetime
  and credentials and does not return an already selected channel to setup.

- PostgreSQL owner tests exercise real claims, simultaneous callers, lease expiry,
  late reconnect/disable/delete/migration results, sibling credential replacement,
  sealed pending credentials, profile retry, safe configuration rearm and bulk
  continuation. Existing envelope mocks cannot prove these transaction races.
- Public controller → real client decoder → directory → managed response tests
  prevent the previously dropped health field. Decoder cases reject invalid
  counters/states; directory tests protect against stale/legacy downgrade.
- Google exchange tests distinguish exact token rejection from profile/generic
  errors, preserve stable credentials and prevent calls with missing configuration.
- V2 workflow tests exercise retry delays, stopped rows, cursor retention and
  history continuation. They do not claim a live Temporal server replay test.
- The existing Temporal boundary test now also protects pending envelopes. The
  existing PostgreSQL CI job runs both ownership and recovery tests. Migration is
  rehearsed on disposable local PostgreSQL by applying the baseline schema and
  this artifact, then comparing the resulting schema with Prisma.
