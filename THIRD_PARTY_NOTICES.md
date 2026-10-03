# Third-party notices

Woof adapts code and tests from these MIT-licensed projects. The attribution and licenses below apply to those portions.

## herdr-orch

Source: https://github.com/ellingtonsp/herdr-orch

Go source and tests adapted for Unix socket RPC, Herdr transport/subscriptions, SQLite transactions/events, mailbox and ask/reply, daemon ownership, lifecycle settlement, watchdog escalation, and safe release. The global multi-session and logical-worker boundaries are rewritten for Woof.


```text
MIT License

Copyright (c) 2026 Stephen Ellington

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## herdr-projects

Source: https://github.com/eliasstravik/herdr-projects

Rust profile name/default/argv/home-expansion and roster concepts from `src/profiles.rs` are translated into Go under `internal/profiles`. ANSI editor/draft detection from `src/prompt_box.rs` and the original `tests/fixtures/prompt_box/*.ansi` files are adapted under `internal/prompt`. Plugin/skill ergonomics from `src/setup.rs` and `skill/COORDINATOR.md` inform the usage guide; automatic hooks/settings installation, provider resolvers, and file-owned coordination state are excluded.


```text
MIT License

Copyright (c) 2026 Elias Stravik

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
