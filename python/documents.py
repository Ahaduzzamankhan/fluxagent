"""
FluxAgent — documents module.

Text extraction from PDF/DOCX/etc. Requires PyMuPDF / python-docx —
deliberately NOT installed; structured dependency errors keep the interface
stable until then. Plain-text extraction works stdlib-only today.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable


def _require_pymupdf() -> Any:
    try:
        import fitz  # PyMuPDF  # type: ignore[import-untyped]

        return fitz
    except ImportError as exc:
        raise RuntimeError(
            json.dumps(
                {
                    "code": "E_DEPENDENCY_MISSING",
                    "message": "documents requires PyMuPDF (pip install PyMuPDF). Intentionally not installed yet.",
                }
            )
        ) from exc


def extract_text(args: dict[str, Any]) -> dict[str, Any]:
    """
    Extract text from `path`. Plain .txt works stdlib-only now; PDF/DOCX
    activate once their libraries are installed.
    """
    path = str(args.get("path", ""))
    if not path:
        return {"error": "path required"}
    p = Path(path)
    if not p.exists():
        return {"error": f"not found: {path}"}

    suffix = p.suffix.lower()
    if suffix in (".txt", ".md", ".csv", ".json", ".log"):
        text = p.read_text(encoding="utf-8", errors="replace")
        return {"text": text, "kind": "plain", "chars": len(text)}

    if suffix == ".pdf":
        _require_pymupdf()
        raise RuntimeError(json.dumps({"code": "E_NOT_IMPLEMENTED", "message": "pdf: activate once PyMuPDF is installed"}))

    if suffix in (".docx",):
        raise RuntimeError(
            json.dumps({"code": "E_DEPENDENCY_MISSING", "message": "docx requires python-docx (pip install python-docx)"})
        )

    return {"error": f"unsupported extension: {suffix}"}


FUNCTIONS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "extract_text": extract_text,
}
