[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/OG2BIT001/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/OG2BIT001/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
# mend: one patch tool for every AI edit format

`mend` applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — and
`mend` reads all four to the single contract in `SPEC.md`, finds the lines an
edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-` (or nothing) to read it from standard input.
`--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
(the default, which detects the format). `--check` reports what would change
without writing anything. `--strict` matches lines exactly, tier 0 only.

## How it works

- Line matching runs at three tiers: exact, then ignoring trailing spaces and
  tabs, then ignoring leading and trailing spaces and tabs. The first tier
  where the old lines occur is the one used, and new lines are re-indented to
  the file's own indentation at tier 2. Context lines are always written back
  as the file's own matched lines, never the patch's.
- Unified hunks take the occurrence nearest the hunk's stated line number
  (adjusted for earlier hunks), insert pure additions after the stated line,
  and honour `\ No newline at end of file` markers. Sections can create,
  delete, rename, or change files.
- SEARCH/REPLACE blocks take the path from the line above the block (fences
  skipped), fail as `ambiguous` when the old lines occur more than once, and
  create a file when the old side is empty.
- V4A sections add, delete, or update files; update chunks anchor on a line
  and apply in order behind a cursor, with `*** End of File` pinning a chunk
  to the end of the file, and `*** Move to:` renaming the file.
- JSON edits are one array or one object per line: `create`, `str_replace`
  (exact, once only), and `insert` (by line number), with CRLF files read and
  written back in CRLF.
- Every edit is applied to an in-memory tree first. A failed edit changes
  nothing and the edits after it still run, so every failure is reported; when
  any edit failed, no file is written at all.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks
  from the env, runs `node main.ts` on each one in a fresh directory, and posts
  what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts <path to practice.json>
      node check.ts <path to practice.json> u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## Grading

A check is one run: its arguments, its standard input (or none) and the files
it starts with. It passes when the exit code, everything written to standard
output, and every file afterwards are exactly what SPEC.md says. Standard
error is never compared. The practice set scores 100/100 locally.
