---
"herdr-woof": patch
---

Test suite: the `woof run start` process tests wait for every spawned run host to
exit before removing their temporary workspace (#26). This fixes an intermittent
`ENOTEMPTY` teardown failure on macOS CI; package behaviour is unchanged.
