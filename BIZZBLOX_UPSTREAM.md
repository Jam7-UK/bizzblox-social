# BizzBLOX social upstream provenance

This repository is an AGPL-3.0 adaptation of two upstream projects. Production
builds must name exact commits; branches, tags, package ranges, and `latest` are
not provenance.

| Component                         | Upstream                                    | Pinned revision                            |
| --------------------------------- | ------------------------------------------- | ------------------------------------------ |
| Postiz application                | <https://github.com/gitroomhq/postiz-app>   | `0f1647f7491a217d43eb5ae7a480484bdf0aff3e` |
| Postiz Agent behavioral reference | <https://github.com/gitroomhq/postiz-agent> | `77d09c668cb2f7793989a185844d0a0c3d65c951` |

The Postiz application commit is an ancestor of the BizzBLOX service branch.
The Agent code is not installed or spawned: its provider-neutral behavior is
adapted in `libraries/postiz-agent-client`, whose `UPSTREAM.md` records the
same Agent revision and the excluded CLI/process behavior.

## Patch and update policy

1. Fetch `upstream` without rewriting history or attribution.
2. Review a proposed exact upstream commit for database, OAuth, provider,
   licensing, route, and dependency changes.
3. Update this file, `NOTICE`, the Agent library provenance if applicable, and
   the source checker in one reviewed change.
4. Re-run the full service tests, production builds, SBOM/vulnerability review,
   tenant-isolation probes, and corresponding-source archive check.
5. Promote only immutable image digests whose OCI revision label is the exact
   reviewed BizzBLOX commit.

The deployed revision is read from the immutable ECR image digest and its
`org.opencontainers.image.revision` label. Complete corresponding source is
published at `https://github.com/Jam7-UK/bizzblox-social/tree/<revision>` and in
the matching workflow archive. No deployment may point at a revision that is
not publicly retrievable from that repository.

The Node 22.22.1 Bookworm Slim base-image index was read from Docker Hub on
2026-08-28 and is pinned in `Dockerfile.production` by digest. A reviewed
dependency/base-image promotion must update that digest explicitly.
