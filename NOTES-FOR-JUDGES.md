# Notes for the judges

Everything below is checkable. Where a number appears, the command that produced
it is next to it, so nothing here has to be taken on trust.

---

## The 30-second version

Open **https://map-room-beta.vercel.app** on your phone. You will see a city of
blocks — one block per file in a real repository. Pick any project and watch.

When an AI coding agent reads a file, that file's block turns **green** on your
screen, and on every other screen open at that moment. Nobody refreshed, and
nothing is polling. The agent's tool call went into SpacetimeDB and came straight
back out to every subscribed tab.

- **green** — read just now, still in the agent's context
- **red** — read a while ago, has fallen out of context
- **blue** — a file the agent *created*, which did not exist when the map was cut
- **orange** — a file the agent *changed*
- **unlit** — never opened

The point of the product is that last one. The blocks that never light are the
parts of your codebase your agent never looked at, and today those are invisible
to you.

---

## Where SpacetimeDB is doing the work

Not "a database behind an API server". There is **no backend of ours anywhere** —
no Node process, no Express, no serverless function. The Vercel URL serves static
files. Every piece of logic runs inside the SpacetimeDB module.

```
agent's tool call ─▶ SpacetimeDB reducer ─▶ subscription ─▶ every open tab
                          (the only server there is)
```

**20 tables, 17 reducers, 4 procedures, 3,043 lines** in `module/src/index.ts`
(`grep -cE '^const [a-z_]+ = table\(' module/src/index.ts`).

Four things carry the architecture:

**1. Tables are the state, not a cache of it.** The client holds no source of
truth. What the map draws is a direct projection of `node`, `edge`, `node_cov`
and `touch`. There is nothing to invalidate because there is no second copy.

**2. Subscriptions replace the realtime layer we did not build.** No WebSocket
server, no pub/sub broker, no polling loop. A tab subscribes with SQL and the
database pushes. Median propagation from tool call to a second browser is **6 ms**.

**3. Procedures do the outbound HTTP, so there is no backend to host.** This is
the piece that removes the server entirely. `index_repo` calls
`ctx.http.fetch` against the GitHub trees API *from inside the module*, walks the
response, and writes the graph in a transaction via `ctx.withTx`. Paste
`django/django` and 2,975 files become a map in about three seconds — with no
code of ours running anywhere but inside SpacetimeDB. `enrich_repo` does the same
against an LLM to write per-file explanations.

**4. Reducers make concurrent agents safe by construction.** Several agents and
several browsers write at once. `report_touch` is a transaction, so the "has this
file been seen before, and by whom" read-modify-write cannot interleave. We wrote
no locking code because there was no place to put a race.

Detail in `docs/SPACETIMEDB.md`; the architecture in `docs/ARCHITECTURE.md`.

---

## How this was built, and how to verify it

**One Claude Code session, start to finish.** The repo and the prompts that
produced it are the same session — no work was moved in from anywhere else.

| | |
|---|---|
| Claude Code session id | `2b7dbe79-be1d-48fe-a172-fa3cb8edfe09` |
| Repository created | 2026-09-05 **14:22 IST** (`gh api repos/Piyush-sahoo/spacetime-hacks --jq .created_at` → `08:52:06Z`) |
| First commit | 2026-09-05 **15:23 IST** |
| Last commit | 2026-09-06 **07:47 IST** |
| Commits | **70** (`git rev-list --count HEAD`) |
| Subagents spawned | **46** |

The 46 subagents are on disk as one metadata file each, and are the honest record
of how the work was split — a subagent per bounded problem (the import-edge
resolver, the isometric layout, the colour state machine, the hook transport),
each returning to the main session to be reconciled. `ls ~/.claude/projects/
-Users-piyuzz-Public-personal-projects--hackathon--spacetime/
2b7dbe79-be1d-48fe-a172-fa3cb8edfe09/subagents/*.meta.json | wc -l`

`docs/PROCESS.md` records what broke along the way, including the bugs that were
demo-fatal. It is deliberately not a success story.

---

## What we are not claiming

We would rather say these ourselves than have you find them.

**No authorization on the module.** Any caller who knows a reducer name can
invoke it, including `reset_coverage`. This is a hackathon build on a public
maincloud module and it is not multi-tenant safe. It is the first thing that
would need fixing.

**The `touch` table is public.** File paths an agent visited are readable by
anyone subscribed. Fine for public repositories, wrong for private ones.

**Enrichment is time-capped**, not completeness-capped — a 150-second wall clock.
A large repository gets a partly-explained map, and the map says so rather than
pretending otherwise.

**No automated test suite.** There is no test script in `client/package.json` and
no test files. Everything was verified by driving a real browser against the live
deployment. That is a defensible choice under a 17-hour clock, but it is a choice,
and it should be read as one.

**The recall numbers on the landing page are from published SWE-bench Verified
data — 172 labelled fixes across 7 repositories — not from measuring your
repository.** We deliberately do not print a recall number for your repo, because
it is not computable without labelled fixes. The map reports what *was* explored.
It does not claim what was missed.

**One seeded repository is unenriched** (the original django corpus), so its
blocks have no written explanations.

---

## Fastest way to see it working

1. Open https://map-room-beta.vercel.app and pick any project.
2. Open the same project in a second tab, or on your phone.
3. Install the plugin in a Claude Code / Codex / Cursor / opencode session
   (`README.md`, one copy-paste) and ask the agent to read any file.
4. Watch the block go green in **both** places at once.

If you would rather not install anything: click any unlit block. That queues a
question for the agent, and the queue is itself a SpacetimeDB table — so the
request appears instantly in every other tab too.
