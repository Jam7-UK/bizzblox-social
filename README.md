# BizzBLOX Social

This repository is the public corresponding source for the managed social
publishing service operated by Jam 7 Ltd. It is derived from
[Postiz](https://github.com/gitroomhq/postiz-app) and is not the BizzBLOX
customer interface or support site.

## Source and licence

The complete source is licensed under
[GNU AGPL version 3](LICENSE). Upstream provenance and the relevant source
revision are recorded in [BIZZBLOX_UPSTREAM.md](BIZZBLOX_UPSTREAM.md), and
modification notices are recorded in [NOTICE](NOTICE).

Each deployed image is tied to an exact commit in this repository. The source
for that version is available at:

```text
https://github.com/Jam7-UK/bizzblox-social/tree/<deployed-commit>
```

No production version is represented as deployed until its exact commit and
image digest have passed the BizzBLOX production release controls.

## Build

Requirements: Node.js `>=22.12.0 <23.0.0` and pnpm `10.6.1`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

The repository includes the source and scripts used to build the service.
Deployment credentials, customer data, provider tokens, and BizzBLOX
proprietary source are not part of this repository.

## Security

Please follow [SECURITY.md](SECURITY.md). Do not publish vulnerability details
in a public issue.
