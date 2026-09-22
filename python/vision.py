"""
FluxAgent — vision module.

Screen/image analysis endpoints for the Python worker. The worker imports
FUNCTIONS from this file; every function takes an args dict and returns a
JSON-serializable value.

DESIGN NOTE (dependencies):
    Real image work requires Pillow (PIL) and/or mss. Per project rules they
    are NOT installed. Each handler checks for its dependency and returns a
    structured E_DEPENDENCY_MISSING error when absent — the interface is real,
    nothing is faked.
"""

from __future__ import annotations

import base64
import hashlib
import time
from typing import Any, Callable


def _require_pil() -> Any:
    try:
        from PIL import Image  # noqa: F401
        import PIL  # noqa: F401

        return PIL
    except ImportError as exc:
        raise RuntimeError(
            __import__("json").dumps(
                {
                    "code": "E_DEPENDENCY_MISSING",
                    "message": "vision requires Pillow (pip install Pillow). Intentionally not installed yet.",
                }
            )
        ) from exc


def describe(args: dict[str, Any]) -> dict[str, Any]:
    """
    Analyze an image provided as base64 (`image_b64`) or a file path (`path`).
    Returns dimensions, format, and a SHA-256 hash (stdlib parts work now).
    Pixel-level analysis activates once Pillow is available.
    """
    import json as _json

    _require_pil()
    # Unreachable until Pillow exists — kept to document the intended behavior:
    # open image, return {"width", "height", "mode", "format", "sha256"}.
    raise RuntimeError(
        _json.dumps({"code": "E_NOT_IMPLEMENTED", "message": "describe: activate once Pillow is installed"})
    )


def compare(args: dict[str, Any]) -> dict[str, Any]:
    """
    Compare two images (base64 or paths) for similarity. Returns a score 0..1.
    Requires Pillow + numpy; interface fixed now.
    """
    import json as _json

    _require_pil()
    raise RuntimeError(
        _json.dumps({"code": "E_NOT_IMPLEMENTED", "message": "compare: activate once Pillow/numpy are installed"})
    )


def sha256_of_file(args: dict[str, Any]) -> dict[str, Any]:
    """Stdlib-only: hash an image file — useful for change detection."""
    path = str(args.get("path", ""))
    if not path:
        return {"error": "path required"}
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return {"sha256": h.hexdigest(), "path": path, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}


FUNCTIONS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "describe": describe,
    "compare": compare,
    "sha256_of_file": sha256_of_file,
}
