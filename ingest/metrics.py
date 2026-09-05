"""The numbers the seeder computes locally, before it ships anything.

* `test_to_code_reachability` — test -> code reachability at k=6. Label-free:
  what fraction of the graph's Test nodes sit within 6 backward hops of some
  Function node. Equivalently (and this is how it is computed, because it is
  cheaper per test): what fraction of Test nodes reach a Function within 6
  FORWARD hops, since T is within 6 backward hops of F exactly when F is within
  6 forward hops of T. It needs no ground truth, which is the point — an
  unlabelled repo has none.

* `backward_walk` — the same bounded k=6 predecessor BFS the module's
  `step_walk` performs, run locally so the seed can print the exact per-hop
  frontier sizes the demo should paint, and name the labelled guarding test the
  walk never reaches.

* `wilson_lb` — the one-sided Wilson score lower bound, textbook form, used on
  the carried prior to produce the verdict the module will insert.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

import networkx as nx

# The carried prior quoted in CONTRACT.md: arm B pooled recall 0.419 (72/172)
# measured across 172 labelled fixes in 7 repos.
PRIOR_HITS = 72
PRIOR_N = 172
SAFE_SKIP_RECALL = 0.95
WALK_K = 6
Z_95_ONE_SIDED = 1.645


def wilson_lb(hits: int, n: int, z: float = Z_95_ONE_SIDED) -> float:
    """One-sided Wilson score lower bound on a binomial proportion.

    Standard closed form. With z = 1.645 this is the 95% one-sided bound. It is
    deliberately the bound and not the point estimate: a bound punishes small
    samples, so a perfect 3/3 cannot clear a 0.95 bar.
    """
    if n <= 0:
        return 0.0
    p = hits / n
    z2 = z * z
    denom = 1.0 + z2 / n
    centre = p + z2 / (2.0 * n)
    margin = z * math.sqrt((p * (1.0 - p) + z2 / (4.0 * n)) / n)
    return (centre - margin) / denom


def to_nx(edges: Iterable[tuple[int, int, str]], nodes: Iterable[int]) -> nx.DiGraph:
    """Directed graph over the shipped rows. Direction is preserved as-is:
    an edge is `caller -> callee`, so a test points AT the code it exercises."""
    g = nx.DiGraph()
    g.add_nodes_from(nodes)
    for src, dst, _kind in edges:
        g.add_edge(src, dst)
    return g


# --------------------------------------------------------------------------
# reachability @ k
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Reachability:
    k: int
    tests: int
    reached: int

    @property
    def value(self) -> float:
        return self.reached / self.tests if self.tests else 0.0


def test_to_code_reachability(g: nx.DiGraph, test_ids: set[int],
                              k: int = WALK_K) -> Reachability:
    """Fraction of Test nodes within `k` hops of any Function node.

    Per-test bounded BFS along successors, stopping the moment a Function is
    seen. The bound is mandatory so the number means exactly one thing and is
    reproducible from the shipped files alone.
    """
    functions = set(g.nodes) - test_ids
    if not test_ids or not functions:
        return Reachability(k, len(test_ids), 0)

    reached = 0
    for start in test_ids:
        if start not in g:
            continue
        frontier = {start}
        seen = {start}
        for _ in range(k):
            nxt: set[int] = set()
            for node in frontier:
                nxt.update(g.successors(node))
            nxt -= seen
            if not nxt:
                break
            if nxt & functions:
                reached += 1
                break
            seen |= nxt
            frontier = nxt
    return Reachability(k, len(test_ids), reached)


# --------------------------------------------------------------------------
# the bounded backward walk (what step_walk does, hop for hop)
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Walk:
    k: int
    origins: tuple[int, ...]
    hops: tuple[int, ...]          # frontier size at hop 1..n
    visited: frozenset[int]
    graph_complete: bool           # frontier exhausted BEFORE the bound

    @property
    def hop_count(self) -> int:
        return len(self.hops)


def backward_walk(g: nx.DiGraph, origins: Iterable[int], k: int = WALK_K) -> Walk:
    """Expand `k` hops over PREDECESSORS, recording one frontier per hop.

    Direction is the whole trick and it is easy to get backwards: production
    code carries no edge to the test that guards it, the test carries the edge
    to the code. So a walk that starts at a changed symbol and hopes to find its
    tests must run against the arrows.

    `graph_complete` is True when the frontier empties before hop `k` — complete
    with respect to the edges this graph HAS, which says nothing about edges the
    extractor never recorded.
    """
    if isinstance(k, bool) or not isinstance(k, int) or k < 1:
        raise ValueError("k must be a positive integer: the bound is mandatory")

    frontier = {o for o in origins if o in g}
    visited = set(frontier)
    hops: list[int] = []
    complete = False

    for _ in range(k):
        nxt: set[int] = set()
        for node in frontier:
            nxt.update(g.predecessors(node))
        nxt -= visited
        if not nxt:
            complete = True
            break
        hops.append(len(nxt))
        visited |= nxt
        frontier = nxt

    return Walk(k=k, origins=tuple(sorted({o for o in origins if o in g})),
                hops=tuple(hops), visited=frozenset(visited),
                graph_complete=complete)


# --------------------------------------------------------------------------
# the verdict
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Verdict:
    decision: str
    recall_prior: float
    wilson_lb: float
    threshold: float
    reason: str
    missed_test: int


def verdict_for(missed_test: int) -> Verdict:
    """The verdict the module inserts when the walk finishes. Computed here too
    so the seed run prints the exact strings before anything is published."""
    lb = wilson_lb(PRIOR_HITS, PRIOR_N)
    prior = PRIOR_HITS / PRIOR_N
    return Verdict(
        decision="RUN_FULL" if lb < SAFE_SKIP_RECALL else "SKIP_SAFE",
        recall_prior=prior,
        wilson_lb=lb,
        threshold=SAFE_SKIP_RECALL,
        reason=(
            f"recall is not computable on an unlabelled repo: there is no ground "
            f"truth here to score the walk against. The decision cites the "
            f"measured prior instead — {PRIOR_HITS}/{PRIOR_N} labelled fixes "
            f"across 7 repos, recall {prior:.3f}, one-sided 95% lower bound "
            f"{lb:.3f}, below the {SAFE_SKIP_RECALL:.2f} bar. Run everything."
        ),
        missed_test=missed_test,
    )
