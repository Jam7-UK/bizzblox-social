# Postiz Agent provenance

This library adapts the public API behavior of
[`gitroomhq/postiz-agent`](https://github.com/gitroomhq/postiz-agent) at exact
revision `77d09c668cb2f7793989a185844d0a0c3d65c951`.

The referenced project and this adaptation are licensed under AGPL-3.0. The
upstream command names, API routes, request envelopes, date defaults, upload
shape, provider-contract discovery, provider helper calls, publication
lifecycle, and analytics behavior informed this implementation.

Jam 7's adaptation deliberately excludes the CLI lifecycle and presentation
layer: command-line parsing, environment and home-directory credentials,
filesystem reads, device login, browser opening, console rendering, and
`process.exit` behavior are not imported or invoked. All I/O is supplied by an
injected typed transport and credential resolver. Provider rejection text is
bounded and redacted before it leaves the adapter.

When updating this library, first review a new exact upstream commit, record it
here and in `BIZZBLOX_UPSTREAM.md`, then repeat the behavioral comparison and
redaction tests. Never track an upstream branch or mutable package tag.
