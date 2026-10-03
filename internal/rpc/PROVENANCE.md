# RPC provenance

`rpc.go` adapts `herdr-orch/internal/rpc/rpc.go` under its MIT license
(see `LICENSE.MIT` and `../../THIRD_PARTY_NOTICES.md`). NDJSON framing is retained;
version checks, cancellation and distinction between unsent and possibly accepted
requests are explicit. `rpc_test.go` is Woof-specific coverage for partial writes,
lost replies, cancellation and stream framing.
