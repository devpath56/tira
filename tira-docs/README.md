# tira-docs

One file per page component, in `components/`. Each says the job it serves, what it is and
why, how to read it, the DOM hooks a test (or a person with devtools) can check, and the
falsifier that would prove it wrong. `test/docs.test.ts` checks every hook named under
"Devtool hook" exists in a rendered page, so the docs can't drift from the build.

When a component splits, its file splits. Every new mark on the page gets its line here.
