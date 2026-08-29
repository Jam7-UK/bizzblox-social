# Upstream provenance

This repository is derived from the complete Postiz source history.

| Component | Upstream | Reviewed revision |
| --- | --- | --- |
| Postiz | https://github.com/gitroomhq/postiz-app | `0f1647f7491a217d43eb5ae7a480484bdf0aff3e` |
| Postiz Agent reference | https://github.com/gitroomhq/postiz-agent | `77d09c668cb2f7793989a185844d0a0c3d65c951` |

The Postiz Agent revision is recorded as a reviewed behavioural reference. Its
source is not included in this initial fork revision. If derived Agent code is
added, its complete corresponding source and notices must be committed here
before release.

Upstream updates are merged only as an explicit, reviewed change. Production
uses an exact commit from this repository and immutable image digests; it never
tracks an upstream branch or mutable image tag.
