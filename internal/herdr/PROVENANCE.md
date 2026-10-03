# Herdr transport provenance

`client.go` adapts `herdr-orch/internal/herdr/client.go` under its MIT license
(see `LICENSE.MIT` and `../../THIRD_PARTY_NOTICES.md`). Protocol 22 framing,
subscriptions and explicit socket selection are retained. Literal launch argv,
subscription confirmation, faithful ANSI reads and conservative uncertainty are
strengthened for Woof. `client_test.go` adds Woof-specific transport and payload
regressions; the donor had no separate `internal/herdr/client_test.go`.
