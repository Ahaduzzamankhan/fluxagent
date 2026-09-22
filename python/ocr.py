"""
FluxAgent — OCR module.

Text extraction from images. Requires pytesseract + the Tesseract binary —
deliberately NOT installed yet; handlers return structured dependency errors
while keeping the worker-facing interface stable.
"""

from __future__ import annotations

import json
from typing import Any, Callable


def _require_pytesseract() -> Any:
    try:
        import pytesseract  # type: ignore[import-untyped]

        return pytesseract
    except ImportError as exc:
        raise RuntimeError(
            json.dumps(
                {
                    "code": "E_DEPENDENCY_MISSING",
                    "message": "ocr requires pytesseract (pip install pytesseract) plus the Tesseract engine. "
                    "Intentionally not installed yet.",
                }
            )
        ) from exc


def extract(args: dict[str, Any]) -> dict[str, Any]:
    """
    Extract text from an image (base64 or file path).
    Planned return: {"text": str, "confidence": float, "words": [...]}.
    """
    _require_pytesseract()
    raise RuntimeError(json.dumps({"code": "E_NOT_IMPLEMENTED", "message": "extract: activate once pytesseract is installed"}))


def available(args: dict[str, Any]) -> dict[str, Any]:
    """Report OCR availability + engine version (safe to call anytime)."""
    try:
        import pytesseract  # type: ignore[import-untyped]

        return {"available": True, "version": pytesseract.get_tesseract_version().__str__()}
    except Exception:
        return {"available": False, "reason": "pytesseract/tesseract not installed (by design, for now)"}


FUNCTIONS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "extract": extract,
    "available": available,
}
