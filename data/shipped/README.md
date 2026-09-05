# Seed corpus

Call graphs for 50 SWE-bench Verified django instances, used to seed rooms in
The Map Room.

## Layout

| Path | What |
|---|---|
| `arms/manifest.jsonl` | Per-instance node/edge counts, id band, and the labels: `fix_site_ids` (where the fix landed) and `test_target_ids` (the tests that guard it). |
| `arms/<instance>/nodes.ndjson.gz` | One JSON object per line: `{"label","id","sid","name","qual"}`. `label` is one of `Function`, `Class`, `File`, `Test`, `ConfigKey`. |
| `arms/<instance>/edges.ndjson.gz` | One JSON object per line: `{"src","dst","type","weight"}`. |
| `split.json` | A pinned `sha256(instance_id)` split, committed before measurement. |
| `gate-results.json` | Per-instance outcomes behind the published recall figures. |

## Two graph classes

Each instance is available in two resolutions of the same repository at the same
commit:

- **arm_a — name-matched.** A call `x.foo()` becomes an edge to *every* function
  named `foo`. This is the graph class Aider's repo map, RepoGraph and LocAgent
  build.
- **arm_b — type-resolved.** The same repository indexed with `scip-python`
  (pyright-backed), so `x.foo()` resolves on the actual static type of `x`, or to
  nothing when the receiver's type is unknown.

Ids live in disjoint bands so both arms can be resident at once without collision.

## The labels are not ours

SWE-bench's `FAIL_TO_PASS` test **is** the test that guards the fix. If a walk over
the graph does not reach it, a tool that selected tests on that graph would have
dropped the one test that catches the bug.

## Source

SWE-bench Verified (public dataset). The full multi-repository corpus is ~4.5 GB and
is not shipped; what ships here is the committed per-instance output.
