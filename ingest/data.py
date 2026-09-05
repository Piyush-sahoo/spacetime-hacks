"""Read the shipped arm payloads and the manifest labels.

Verified on-disk format (CONTRACT.md, re-checked against the bytes):

    nodes.ndjson.gz : {"label":"Function","id":10000000000,"sid":"10000000000",
                       "name":"setup","qual":"django.__init__::setup"}
    edges.ndjson.gz : {"src":10000000000,"dst":10000000001,"type":"CALLS","weight":1}

Two facts the CONTRACT does not spell out but the bytes do, and which the
seeder has to handle:

1. The shipped ``<instance>/{nodes,edges}.ndjson.gz`` are the **merged** payload
   for BOTH extraction arms. Arm A ids live in the 10_xxx band, arm B in the
   20_xxx band, disjoint by construction, so an arm is recovered by filtering on
   the band recorded in the manifest (``arm_a.band`` / ``arm_b.band``, rounded to
   1e10). django__django-10097 merged = 20813 nodes / 40039 edges, which is the
   number CONTRACT.md quotes.
2. Every shipped node carries ``label == "Function"``. There is no ``Test``
   label on disk. The Map Room needs one (the verdict lights a test red), so
   ``kind_of`` derives it from the symbol itself: a Test is a function whose
   leaf name starts with ``test`` inside a module whose path mentions ``test``.
   This is label-free — it never reads ``test_target_ids`` — and it covers
   612/612 of the labelled targets on django__django-10097.
"""

from __future__ import annotations

import gzip
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

DEFAULT_ARMS_ROOT = Path("data/shipped/arms")
BAND_WIDTH = 10_000_000_000


# --------------------------------------------------------------------------
# manifest
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class ArmEntry:
    instance_id: str
    arm: str
    band: int
    nodes: int
    edges: int
    fix_site_ids: tuple[int, ...]
    test_target_ids: tuple[int, ...]

    @property
    def usable(self) -> bool:
        """Has a real origin to click AND a labelled test to miss."""
        return bool(self.fix_site_ids) and bool(self.test_target_ids)


def iter_manifest(manifest_path: Path) -> Iterator[dict]:
    with Path(manifest_path).open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def arm_entries(manifest_path: Path) -> list[ArmEntry]:
    out: list[ArmEntry] = []
    for record in iter_manifest(manifest_path):
        for arm in ("arm_a", "arm_b"):
            entry = record.get(arm) or {}
            if not entry:
                continue
            out.append(ArmEntry(
                instance_id=record["instance_id"],
                arm=arm,
                band=int(entry.get("band") or 0),
                nodes=int(entry.get("nodes") or 0),
                edges=int(entry.get("edges") or 0),
                fix_site_ids=tuple(int(x) for x in (entry.get("fix_site_ids") or ())),
                test_target_ids=tuple(int(x) for x in (entry.get("test_target_ids") or ())),
            ))
    return out


def find_entry(manifest_path: Path, instance_id: str, arm: str | None) -> ArmEntry:
    """Resolve one arm entry. ``arm=None`` picks the arm that is actually usable.
    ``arm="merged"`` returns a synthetic entry over the whole shipped payload
    (band 0 = no filter), which is the 20813-node / 40039-edge graph CONTRACT.md
    quotes for django__django-10097. The two arms are disjoint id bands, so the
    merged graph is two components — correct to load, but the walk only ever
    lives in one of them.

    Preference order when auto-picking: arm_b (type-resolved, measured recall
    0.419) then arm_a (name-matched, 0.314) — but only among arms that carry a
    non-empty ``fix_site_ids``, because an empty origin set is a demo with
    nothing to click.
    """
    entries = [e for e in arm_entries(manifest_path) if e.instance_id == instance_id]
    if not entries:
        raise SystemExit(f"instance {instance_id!r} is not in {manifest_path}")
    if arm == "merged":
        fix = tuple(sorted({x for e in entries for x in e.fix_site_ids}))
        tgt = tuple(sorted({x for e in entries for x in e.test_target_ids}))
        return ArmEntry(instance_id=instance_id, arm="merged", band=0,
                        nodes=sum(e.nodes for e in entries),
                        edges=sum(e.edges for e in entries),
                        fix_site_ids=fix, test_target_ids=tgt)
    if arm is not None:
        for e in entries:
            if e.arm == arm:
                return e
        raise SystemExit(f"instance {instance_id!r} has no {arm}")
    for want in ("arm_b", "arm_a"):
        for e in entries:
            if e.arm == want and e.usable:
                return e
    # nothing usable: fall back to whatever exists so --dry-run still reports
    return entries[0]


# --------------------------------------------------------------------------
# graph payload
# --------------------------------------------------------------------------

def _read_ndjson_gz(path: Path) -> Iterator[dict]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def _leaf(name: str) -> str:
    """`Cls#test_foo().` -> `test_foo`, `setup` -> `setup`."""
    return name.split("#")[-1].split("(")[0].strip()


def kind_of(row: dict) -> str:
    """Map a shipped node onto the CONTRACT's `node.kind` vocabulary.

    Label-free: reads only `name`/`qual`, never the manifest labels. The shipped
    payload only ever carries `label == "Function"`, so the interesting call is
    Function vs Test; File/Class/ConfigKey are passed through if a future
    payload emits them.
    """
    label = row.get("label") or "Function"
    if label != "Function":
        return label
    module = (row.get("qual") or "").split("::", 1)[0].lower()
    if _leaf(row.get("name") or "").startswith("test") and "test" in module:
        return "Test"
    return "Function"


@dataclass
class Graph:
    """The instance graph for ONE arm, ready to ship."""

    instance_id: str
    arm: str
    nodes: dict[int, dict] = field(default_factory=dict)   # id -> {kind,name,qual}
    edges: list[tuple[int, int, str]] = field(default_factory=list)

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    @property
    def edge_count(self) -> int:
        return len(self.edges)

    def test_ids(self) -> set[int]:
        return {i for i, r in self.nodes.items() if r["kind"] == "Test"}

    def node_rows(self) -> list[dict]:
        return [{"id": i, "kind": r["kind"], "name": r["name"], "qual": r["qual"]}
                for i, r in self.nodes.items()]

    def edge_rows(self) -> list[dict]:
        return [{"src": s, "dst": d, "kind": k} for s, d, k in self.edges]


def load_graph(arms_root: Path, entry: ArmEntry) -> Graph:
    """Load one arm out of the merged shipped payload, filtered by id band."""
    root = Path(arms_root) / entry.instance_id
    nodes_path, edges_path = root / "nodes.ndjson.gz", root / "edges.ndjson.gz"
    for p in (nodes_path, edges_path):
        if not p.exists():
            raise SystemExit(f"missing shipped payload: {p}")

    lo = entry.band - (entry.band % BAND_WIDTH)
    hi = lo + BAND_WIDTH

    def in_band(i: int) -> bool:
        return lo <= i < hi if lo else True

    g = Graph(instance_id=entry.instance_id, arm=entry.arm)
    for row in _read_ndjson_gz(nodes_path):
        i = int(row["id"])
        if not in_band(i):
            continue
        g.nodes[i] = {"kind": kind_of(row),
                      "name": str(row.get("name") or ""),
                      "qual": str(row.get("qual") or "")}
    for row in _read_ndjson_gz(edges_path):
        s, d = int(row["src"]), int(row["dst"])
        if s in g.nodes and d in g.nodes:
            g.edges.append((s, d, str(row.get("type") or "CALLS")))
    return g


def backward_subset(g: Graph, origins: list[int], keep: set[int], hops: int) -> Graph:
    """The `hops`-hop BACKWARD neighbourhood of `origins`, plus `keep`.

    Graph-correct in the sense the demo needs: the module's walk runs along
    predecessors, so the induced subgraph on the backward closure reproduces the
    full-graph walk exactly for every hop <= `hops`. `keep` (the labelled test
    targets) is unioned in afterwards so the verdict still has a test to light
    red even when the walk never reaches it — that is the whole point of the
    demo, and dropping those nodes would hide the miss instead of showing it.
    """
    preds: dict[int, list[int]] = {}
    for s, d, _ in g.edges:
        preds.setdefault(d, []).append(s)

    frontier = {o for o in origins if o in g.nodes}
    visited = set(frontier)
    for _ in range(max(0, hops)):
        nxt: set[int] = set()
        for u in frontier:
            nxt.update(preds.get(u, ()))
        nxt -= visited
        if not nxt:
            break
        visited |= nxt
        frontier = nxt

    visited |= {k for k in keep if k in g.nodes}
    sub = Graph(instance_id=g.instance_id, arm=g.arm)
    sub.nodes = {i: g.nodes[i] for i in visited}
    sub.edges = [(s, d, k) for s, d, k in g.edges if s in visited and d in visited]
    return sub


def shift_ids(g: Graph, offset: int) -> Graph:
    """Add `offset` to every id.

    `node.id` is a global primary key in the module schema, not scoped to
    `repo_id`, so two repos built from the same source graph collide and the
    second one's nodes are silently dropped (its edges still land — `edge.id` is
    autoInc). Shifting the whole graph by a per-repo offset keeps both loadable
    and keeps the walk intact, because every edge endpoint moves with it.
    """
    out = Graph(instance_id=g.instance_id, arm=g.arm)
    out.nodes = {i + offset: r for i, r in g.nodes.items()}
    out.edges = [(s + offset, d + offset, k) for s, d, k in g.edges]
    return out
