"""`python -m ingest.seed --instance <id> --module <name>`

Load one shipped arm graph into a published SpacetimeDB
module over the HTTP API, in the order the CONTRACT fixes:

    create_repo(slug, label)
    ingest_nodes(repo_id, rows_json)   x ceil(nodes / batch)   batch <= 1000
    ingest_edges(repo_id, rows_json)   x ceil(edges / batch)
    finish_repo(repo_id, reachability)

`rows_json` is a JSON array STRING (per CONTRACT.md), whose elements are:

    nodes: {"id": u64, "kind": string, "name": string, "qual": string}
    edges: {"src": u64, "dst": u64, "kind": string}

i.e. the `node` / `edge` table columns minus `repo_id` (passed separately) and
minus the autoInc `edge.id`. `--dry-run` prints one of each so the module agent
can diff the shape without a publish.

Batches are clamped to 1000 rows regardless of what `--batch-size` asks for: a
loader that lets the caller pick an unbounded batch size fails in production,
not in test.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from ingest import data as D
from ingest import metrics as M
from ingest.stdb import SpacetimeClient, SpacetimeError, default_host, discover_token

MAX_BATCH = 1000


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

def _console():
    try:
        from rich.console import Console
        return Console(markup=False, highlight=False, soft_wrap=True)
    except Exception:  # noqa: BLE001 - rich is optional at runtime
        class _Plain:
            def print(self, *a, **k):
                print(*[str(x) for x in a], end=k.get("end", "\n"))
            def rule(self, text=""):
                print(f"-- {text} " + "-" * max(0, 60 - len(str(text))))
        return _Plain()


def report_instances(manifest: Path, console) -> None:
    """Which instances actually have an origin to click?"""
    entries = D.arm_entries(manifest)
    by_instance: dict[str, dict[str, D.ArmEntry]] = {}
    for e in entries:
        by_instance.setdefault(e.instance_id, {})[e.arm] = e

    usable = [(i, a) for i, arms in by_instance.items()
              for a, e in sorted(arms.items()) if e.usable]
    console.rule("instances with a usable origin (non-empty fix_site_ids)")
    console.print(f"{len(by_instance)} instances, "
                  f"{len(usable)} usable (instance, arm) pairs")
    console.print("")
    console.print(f"{'instance':<26} {'arm_a fix/test':>16} {'arm_b fix/test':>16}  pick")
    for inst in sorted(by_instance):
        arms = by_instance[inst]
        def cell(a: str) -> str:
            e = arms.get(a)
            if e is None:
                return "-"
            return f"{len(e.fix_site_ids)}/{len(e.test_target_ids)}"
        pick = next((a for a in ("arm_b", "arm_a")
                     if arms.get(a) and arms[a].usable), "NONE")
        console.print(f"{inst:<26} {cell('arm_a'):>16} {cell('arm_b'):>16}  {pick}")


# --------------------------------------------------------------------------
# batching
# --------------------------------------------------------------------------

def chunks(seq: list, size: int):
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


def push(client: SpacetimeClient, reducer: str, repo_id: int, rows: list[dict],
         batch_size: int, console) -> float:
    """Send `rows` through `reducer` in <=batch_size batches. Returns rows/sec."""
    total = len(rows)
    n_batches = (total + batch_size - 1) // batch_size if total else 0
    t0 = time.perf_counter()
    done = 0
    for i, chunk in enumerate(chunks(rows, batch_size), start=1):
        client.call(reducer, [repo_id, json.dumps(chunk, separators=(",", ":"))])
        done += len(chunk)
        elapsed = max(time.perf_counter() - t0, 1e-9)
        console.print(
            f"  {reducer} batch {i}/{n_batches}  {done}/{total} rows  "
            f"{done / elapsed:,.0f} rows/s", end="\r" if i < n_batches else "\n")
    elapsed = max(time.perf_counter() - t0, 1e-9)
    if n_batches == 0:
        console.print(f"  {reducer}: nothing to send")
    return total / elapsed


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m ingest.seed",
        description="Seed a Map Room SpacetimeDB module from a shipped arm graph.")
    p.add_argument("--instance", default="django__django-10097",
                   help="SWE-bench instance id, e.g. django__django-10097")
    p.add_argument("--module", default="map-room",
                   help="published SpacetimeDB database name")
    p.add_argument("--arm", choices=["arm_a", "arm_b", "merged"], default=None,
                   help="which extraction arm; 'merged' ships the whole payload "
                        "(both id bands, two components); "
                        "default: the arm with a usable origin")
    p.add_argument("--host", default=None,
                   help="SpacetimeDB base URL (default: spacetime CLI default_server, "
                        "else https://maincloud.spacetimedb.com)")
    p.add_argument("--token", default=None,
                   help="bearer token; default: $SPACETIME_TOKEN or ~/.config/spacetime/cli.toml")
    p.add_argument("--slug", default=None, help="repo.slug (default: the instance id)")
    p.add_argument("--label", default=None, help="repo.label (default: derived)")
    p.add_argument("--limit", type=int, default=None, metavar="HOPS",
                   help="ship only the HOPS-hop BACKWARD neighbourhood of the origin "
                        "(plus the labelled test targets). Use >= 6 to keep the k=6 "
                        "walk identical to the full graph.")
    p.add_argument("--id-offset", type=int, default=0, metavar="N",
                   help="add N to every node/edge id before shipping. `node.id` is a "
                        "GLOBAL primary key in the module schema, so seeding the same "
                        "graph twice silently drops the second copy's nodes (the edges "
                        "still land, because edge.id is autoInc). Use a distinct offset "
                        "per repo when two repos share source ids.")
    p.add_argument("--batch-size", type=int, default=1000,
                   help="rows per reducer call (clamped to 1000)")
    p.add_argument("--arms-root", default=str(D.DEFAULT_ARMS_ROOT))
    p.add_argument("--manifest", default=None,
                   help="default: <arms-root>/manifest.jsonl")
    p.add_argument("--dry-run", action="store_true",
                   help="do everything except the HTTP calls; print what would be sent")
    p.add_argument("--list-instances", action="store_true",
                   help="report which instances have non-empty fix_site_ids and exit")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    console = _console()

    arms_root = Path(args.arms_root)
    manifest = Path(args.manifest) if args.manifest else arms_root / "manifest.jsonl"
    if not manifest.exists():
        console.print(f"[!] no manifest at {manifest}")
        return 2

    if args.list_instances:
        report_instances(manifest, console)
        return 0

    batch_size = max(1, min(args.batch_size, MAX_BATCH))
    if args.batch_size > MAX_BATCH:
        console.print(f"[!] batch size clamped {args.batch_size} -> {MAX_BATCH}")

    # ---- load -----------------------------------------------------------
    entry = D.find_entry(manifest, args.instance, args.arm)
    if not entry.fix_site_ids:
        console.print(
            f"[!] {entry.instance_id}/{entry.arm} has EMPTY fix_site_ids — there is "
            f"no origin to click. Run --list-instances and pick another instance.")
    t0 = time.perf_counter()
    graph = D.load_graph(arms_root, entry)
    load_s = time.perf_counter() - t0

    console.rule(f"{entry.instance_id} / {entry.arm}")
    console.print(f"shipped payload: {graph.node_count:,} nodes, "
                  f"{graph.edge_count:,} edges  ({load_s:.1f}s)")
    console.print(f"fix_site_ids: {len(entry.fix_site_ids)}   "
                  f"test_target_ids: {len(entry.test_target_ids)}")

    origins = [o for o in entry.fix_site_ids if o in graph.nodes]
    targets = [t for t in entry.test_target_ids if t in graph.nodes]

    if args.limit is not None:
        if args.limit < M.WALK_K:
            console.print(f"[!] --limit {args.limit} < k={M.WALK_K}: the shipped "
                          f"subset will CHANGE the walk's answer, not just shrink it")
        graph = D.backward_subset(graph, origins, set(targets), args.limit)
        console.print(f"--limit {args.limit}: subset -> {graph.node_count:,} nodes, "
                      f"{graph.edge_count:,} edges")

    if args.id_offset:
        graph = D.shift_ids(graph, args.id_offset)
        origins = [o + args.id_offset for o in origins]
        targets = [t + args.id_offset for t in targets]
        console.print(f"--id-offset {args.id_offset:,}: ids shifted "
                      f"(origin -> {origins[0] if origins else 'n/a'})")

    # ---- measure --------------------------------------------------------
    g = M.to_nx(graph.edges, graph.nodes.keys())
    tests = graph.test_ids()
    reach = M.test_to_code_reachability(g, tests, M.WALK_K)
    console.print(f"kinds: {len(tests):,} Test, "
                  f"{graph.node_count - len(tests):,} Function")
    console.print(f"test->code reachability @ k={reach.k}: "
                  f"{reach.reached:,}/{reach.tests:,} = {reach.value:.4f}")

    missed_test = 0
    if origins:
        walk = M.backward_walk(g, origins, M.WALK_K)
        found_tests = walk.visited & tests
        selected = walk.visited & set(targets)
        missed = sorted(set(targets) - selected)
        # Prefer a missed test in the origin's own id band: with --arm merged the
        # payload holds two disjoint arm components, and a test the walk "never
        # reached" because it lives in the other component is a true statement
        # that shows the wrong thing.
        band = origins[0] - (origins[0] % D.BAND_WIDTH)
        same = [m for m in missed if m - (m % D.BAND_WIDTH) == band]
        missed_test = (same or missed or [0])[0]
        console.print(
            f"local k={M.WALK_K} backward walk (what step_walk must reproduce): "
            f"origin={origins[0]} frontier per hop={list(walk.hops)} "
            f"visited={len(walk.visited):,} graph_complete={walk.graph_complete}")
        console.print(
            f"  labelled guarding tests found: {len(selected)}/{len(targets)}   "
            f"any Test node found: {len(found_tests):,}/{len(tests):,} "
            f"({len(found_tests) / max(len(tests), 1):.4f}) — the reachability "
            f"number above is near-saturated because it asks about ANY code, "
            f"not about the code that changed")
        console.print(f"  missed_test -> {missed_test} "
                      f"({graph.nodes.get(missed_test, {}).get('qual', 'n/a')})")
    verdict = M.verdict_for(missed_test)
    console.print(f"verdict: {verdict.decision}  prior={verdict.recall_prior:.3f} "
                  f"wilson_lb={verdict.wilson_lb:.3f} threshold={verdict.threshold}")

    # ---- ship -----------------------------------------------------------
    node_rows = graph.node_rows()
    edge_rows = graph.edge_rows()
    slug = args.slug or entry.instance_id
    label = args.label or f"{entry.instance_id} ({entry.arm})"

    host = args.host or default_host()
    token, token_src = discover_token(args.token)
    console.rule("transport")
    console.print(f"host={host}  module={args.module}  auth={token_src}")
    console.print(f"batches: nodes {(len(node_rows) + batch_size - 1)//batch_size}, "
                  f"edges {(len(edge_rows) + batch_size - 1)//batch_size} "
                  f"(batch_size={batch_size})")

    client = SpacetimeClient(host, args.module, token, dry_run=args.dry_run)
    try:
        if args.dry_run:
            console.print("")
            console.print("DRY RUN — would POST to "
                          f"{host}/v1/database/{args.module}/call/<reducer>")
            console.print(f"  headers: Content-Type: application/json"
                          + (f", Authorization: Bearer <{token_src}>" if token else ""))
            console.print("")
            console.print(f"  1. create_repo   {json.dumps([slug, label])}")
            console.print(f"  2. ingest_nodes  [<repo_id>, "
                          f"\"{json.dumps(node_rows[:1])[1:-1][:160]}...\"]  "
                          f"x{(len(node_rows)+batch_size-1)//batch_size}")
            console.print(f"  3. ingest_edges  [<repo_id>, "
                          f"\"{json.dumps(edge_rows[:1])[1:-1][:160]}...\"]  "
                          f"x{(len(edge_rows)+batch_size-1)//batch_size}")
            console.print(f"  4. finish_repo   "
                          f"[<repo_id>, {round(reach.value, 6)}]")
            sample = json.dumps(node_rows[:2], separators=(",", ":"))
            console.print("")
            console.print(f"  one nodes batch payload (2 rows): {sample}")
            console.print(f"  one edges batch payload (2 rows): "
                          f"{json.dumps(edge_rows[:2], separators=(',', ':'))}")
            est = len(json.dumps(node_rows[:batch_size], separators=(",", ":")))
            console.print(f"  a full {batch_size}-row nodes batch is ~{est/1024:.0f} KiB")
            return 0

        if not client.ping():
            console.print(f"[!] module {args.module!r} is not reachable at {host} "
                          f"(GET /v1/database/{args.module}/schema failed). "
                          f"Publish it, or re-run with --dry-run.")
            return 3

        t_all = time.perf_counter()
        client.call("create_repo", [slug, label])
        repo_id = _repo_id(client, slug, console)
        console.print(f"create_repo -> repo_id={repo_id}")

        n_rate = push(client, "ingest_nodes", repo_id, node_rows, batch_size, console)
        e_rate = push(client, "ingest_edges", repo_id, edge_rows, batch_size, console)
        client.call("finish_repo", [repo_id, round(reach.value, 6)])
        wall = time.perf_counter() - t_all

        console.rule("done")
        console.print(f"repo_id={repo_id} slug={slug}")
        console.print(f"nodes {len(node_rows):,} @ {n_rate:,.0f} rows/s")
        console.print(f"edges {len(edge_rows):,} @ {e_rate:,.0f} rows/s")
        console.print(f"reachability={reach.value:.4f}  "
                      f"reducer calls={len(client.sent)}  wall={wall:.1f}s")
        console.print(f"demo origin: {origins[0] if origins else 'NONE'}   "
                      f"expected missed_test: {missed_test}")
    except SpacetimeError as exc:
        console.print(f"[!] {exc}")
        return 1
    finally:
        client.close()
    return 0


def _repo_id(client: SpacetimeClient, slug: str, console) -> int:
    """Reducers return nothing, so read the autoInc id back over /sql."""
    escaped = slug.replace("'", "''")
    rows = client.sql(f"SELECT * FROM repo WHERE slug = '{escaped}'")
    ids = [int(r["id"]) for r in rows if r.get("id") is not None]
    if not ids:
        raise SpacetimeError(
            f"create_repo ran but no repo row with slug={slug!r} came back from "
            f"/sql — check the module's create_repo and that `repo` is public")
    if len(ids) > 1:
        console.print(f"[!] {len(ids)} repo rows share slug={slug!r}; using the newest")
    return max(ids)


if __name__ == "__main__":
    sys.exit(main())
