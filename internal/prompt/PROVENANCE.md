# Prompt provenance

Draft/placeholder detection is translated from
`herdr-projects/src/prompt_box.rs` (MIT; see `../../THIRD_PARTY_NOTICES.md`).
`testdata/*.ansi`, except `claude-live-unstyled-placeholder.ansi`, retain donor
fixtures from `tests/fixtures/prompt_box`. `TestDonorANSIDrafts` runs each empty
and typed-draft pair. The unstyled Claude fixture was captured from Woof's isolated
live test and verifies that an indistinguishable placeholder cannot authorize input.
Git attributes preserve capture bytes and exempt their intentional screen padding
and carriage returns from source whitespace checks.

Bounded inbox/dispatch notices, artifact pointers and original actor/attachment
flags are Woof additions, tested separately from editor detection.
