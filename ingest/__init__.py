"""The Map Room seeder — load a shipped code graph into a SpacetimeDB module.

Standalone: depends only on httpx, networkx and rich. Reads the public
SWE-bench-derived payload under `data/shipped/arms/` and drives the module's
reducers over the SpacetimeDB HTTP API.

Entry point: `python -m ingest.seed --instance <id> --module <name>`.
"""

__all__ = ["data", "metrics", "stdb", "seed"]
