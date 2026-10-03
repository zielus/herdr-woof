# Profile provenance

`profiles.go` translates name validation, defaults, literal argv/home expansion
and roster concepts from `herdr-projects/src/profiles.rs` (MIT; see
`../../THIRD_PARTY_NOTICES.md`). `profiles_test.go` ports those behavioral cases
to Go and adds strict-field, independent-snapshot and metadata-only roster checks.
Provider/model/effort resolution and profile environment policy are excluded.
