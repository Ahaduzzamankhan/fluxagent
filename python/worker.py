#!/usr/bin/env python3
"""
FluxAgent — Python worker.

A long-lived, stdlib-only worker speaking newline-delimited JSON over
stdin/stdout with the TypeScript bridge (src/python/bridge.ts).

Request:
    {"id": "req_1", "op": "execute", "module": "vision", "function": "info", "args": {}}
Response:
    {"id": "req_1", "ok": true, "result": {...}}
    {"id": "req_1", "ok": false, "error": {"code": "E_PYTHON_MODULE_NOT_FOUND", "message": "..."}}

Heavy optional dependencies (Pillow, mss, numpy, PyMuPDF, etc.) are imported
lazily inside each module function and reported as actionable errors when
missing — the worker itself never crashes because a library is absent.

Run directly for a smoke test:
    echo '{"id":"t","op":"execute","module":"system","function":"info","args":{}}' | python worker.py
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any, Callable

# Module registries are populated lazily to keep startup fast and avoid
# importing optional dependencies at boot.
_MODULES: dict[str, dict[str, Callable[[dict[str, Any]], Any]]] = {}


def register(module: str, functions: dict[str, Callable[[dict[str, Any]], Any]]) -> None:
    _MODULES[module] = functions


def _missing(lib: str, pip_name: str | None = None) -> Callable[[dict[str, Any]], Any]:
    """Build a handler that reports a clearly-marked future dependency."""
    pip = pip_name or lib

    def handler(_args: dict[str, Any]) -> Any:
        raise RuntimeError(
            json.dumps(
                {
                    "code": "E_DEPENDENCY_MISSING",
                    "message": f"This capability requires the '{lib}' package (pip install {pip}). "
                    "Not installed by design yet — see project rules.",
                }
            )
        )

    return handler


def _unwrap_error(exc: BaseException) -> dict[str, str]:
    message = str(exc)
    try:
        parsed = json.loads(message)
        if isinstance(parsed, dict) and "code" in parsed:
            return {"code": str(parsed["code"]), "message": str(parsed.get("message", message))}
    except (json.JSONDecodeError, ValueError):
        pass
    return {"code": "E_PYTHON_BRIDGE", "message": message}


# ── system module (stdlib-only, useful for smoke tests) ──────────────────────
def _system_info(_args: dict[str, Any]) -> dict[str, Any]:
    import platform

    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
    }


register("system", {"info": _system_info})

# ── vision module (future deps: Pillow / mss / numpy — see vision.py) ────────
try:
    from vision import FUNCTIONS as _VISION_FUNCTIONS
except ImportError:
    _VISION_FUNCTIONS = {"describe": _missing("Pillow"), "compare": _missing("Pillow")}

# ── ocr module (future deps: pytesseract / easyocr — see ocr.py) ─────────────
try:
    from ocr import FUNCTIONS as _OCR_FUNCTIONS
except ImportError:
    _OCR_FUNCTIONS = {"extract": _missing("pytesseract")}

# ── embeddings module (future deps: sentence-transformers / numpy) ───────────
try:
    from embeddings import FUNCTIONS as _EMBEDDINGS_FUNCTIONS
except ImportError:
    _EMBEDDINGS_FUNCTIONS = {"embed": _missing("sentence-transformers")}

# ── documents module (future deps: PyMuPDF / python-docx) ────────────────────
try:
    from documents import FUNCTIONS as _DOCUMENTS_FUNCTIONS
except ImportError:
    _DOCUMENTS_FUNCTIONS = {"extract_text": _missing("PyMuPDF")}

register("vision", _VISION_FUNCTIONS)
register("ocr", _OCR_FUNCTIONS)
register("embeddings", _EMBEDDINGS_FUNCTIONS)
register("documents", _DOCUMENTS_FUNCTIONS)


def handle_request(req: dict[str, Any]) -> dict[str, Any]:
    req_id = str(req.get("id", "?"))
    op = req.get("op")

    if op == "shutdown":
        return {"id": req_id, "ok": True, "result": {"bye": True}}

    if op != "execute":
        return {
            "id": req_id,
            "ok": False,
            "error": {"code": "E_PYTHON_BRIDGE", "message": f"unknown op: {op!r}"},
        }

    module = str(req.get("module", ""))
    function = str(req.get("function", ""))
    args = req.get("args") or {}
    if not isinstance(args, dict):
        return {
            "id": req_id,
            "ok": False,
            "error": {"code": "E_VALIDATION", "message": "args must be an object"},
        }

    functions = _MODULES.get(module)
    if functions is None:
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "code": "E_PYTHON_MODULE_NOT_FOUND",
                "message": f"module '{module}' is not registered (have: {sorted(_MODULES)})",
            },
        }

    fn = functions.get(function)
    if fn is None:
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "code": "E_PYTHON_FUNCTION_NOT_FOUND",
                "message": f"function '{function}' not in module '{module}' (have: {sorted(functions)})",
            },
        }

    try:
        result = fn(args)
        return {"id": req_id, "ok": True, "result": result}
    except Exception as exc:  # noqa: BLE001 — boundary: convert to structured error
        return {"id": req_id, "ok": False, "error": _unwrap_error(exc)}


def main() -> None:
    # Line-buffered protocol loop. Errors never kill the worker.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(
                json.dumps({"id": "?", "ok": False, "error": {"code": "E_VALIDATION", "message": f"bad JSON: {exc}"}})
                + "\n"
            )
            sys.stdout.flush()
            continue

        if not isinstance(req, dict):
            sys.stdout.write(
                json.dumps({"id": "?", "ok": False, "error": {"code": "E_VALIDATION", "message": "request must be an object"}})
                + "\n"
            )
            sys.stdout.flush()
            continue

        resp = handle_request(req)
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
        if resp.get("result") == {"bye": True}:
            return


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # TS side closed the pipe; exit quietly.
        sys.exit(0)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
