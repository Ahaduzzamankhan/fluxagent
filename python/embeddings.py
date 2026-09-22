"""
FluxAgent — embeddings module.

Text embedding + cosine similarity endpoints. A real model needs
sentence-transformers (or an API) — intentionally NOT installed; the interface
is fixed and stdlib-only hashing fallback is provided for plumbing tests.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any, Callable


def _require_sentence_transformers() -> Any:
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore[import-untyped]

        return SentenceTransformer
    except ImportError as exc:
        raise RuntimeError(
            json.dumps(
                {
                    "code": "E_DEPENDENCY_MISSING",
                    "message": "embeddings requires sentence-transformers (pip install sentence-transformers). "
                    "Intentionally not installed yet.",
                }
            )
        ) from exc


def embed(args: dict[str, Any]) -> dict[str, Any]:
    """
    Embed `texts` (list of strings). Returns {"embeddings": [[float]], "model": str}.
    Uses a real model once installed; until then use `embed_hash`.
    """
    _require_sentence_transformers()
    raise RuntimeError(json.dumps({"code": "E_NOT_IMPLEMENTED", "message": "embed: activate once sentence-transformers is installed"}))


def embed_hash(args: dict[str, Any]) -> dict[str, Any]:
    """
    Stdlib-only deterministic pseudo-embedding (SHA-256 buckets).
    NOT a semantic embedding — exists so the pipeline can be wired and tested
    end-to-end before a real model is added.
    """
    texts = args.get("texts") or []
    if not isinstance(texts, list):
        return {"error": "texts must be a list of strings"}
    dims = int(args.get("dims", 64))
    dims = max(8, min(dims, 512))
    vectors: list[list[float]] = []
    for t in texts:
        v = [0.0] * dims
        digest = hashlib.sha256(str(t).encode("utf-8")).digest()
        for i in range(dims):
            byte = digest[i % len(digest)]
            v[i] = (byte / 255.0) * 2.0 - 1.0
        vectors.append(v)
    return {"embeddings": vectors, "model": "sha256-hash-fallback", "dims": dims}


def cosine(args: dict[str, Any]) -> dict[str, Any]:
    """Cosine similarity between two vectors (stdlib)."""
    a = args.get("a") or []
    b = args.get("b") or []
    if not a or not b or len(a) != len(b):
        return {"error": "a and b must be equal-length non-empty lists"}
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return {"similarity": 0.0}
    return {"similarity": dot / (na * nb)}


FUNCTIONS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "embed": embed,
    "embed_hash": embed_hash,
    "cosine": cosine,
}
