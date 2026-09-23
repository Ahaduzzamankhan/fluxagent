#!/usr/bin/env bash
# FluxAgent - Linux/macOS installer.
#
# One-line install:
#
#   curl -fsSL https://raw.githubusercontent.com/Ahaduzzamankhan/fluxagent/main/install.sh | bash
#
# What it does:
#   1. Verifies Node.js 22.6+.
#   2. Downloads the FluxAgent source into ~/.fluxagent/app.
#   3. Creates an executable shim at ~/.fluxagent/bin/fluxagent.
#   4. Adds that to PATH via your shell profile.
#   5. Verifies `fluxagent doctor` runs.

set -euo pipefail

REPO="https://github.com/Ahaduzzamankhan/fluxagent"
TARBALL="$REPO/archive/refs/heads/main.tar.gz"
INSTALL_ROOT="$HOME/.fluxagent"
APP_DIR="$INSTALL_ROOT/app"
BIN_DIR="$INSTALL_ROOT/bin"

say()  { printf 'fluxagent: %s\n' "$1"; }
die()  { printf 'fluxagent: ERROR: %s\n' "$1" >&2; exit 1; }

# ── 1. Node.js check ─────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
    die "Node.js is not installed. Install Node 22.6+ from https://nodejs.org and re-run."
fi
NODE_VER="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
    die "Node.js $NODE_VER found but FluxAgent needs 22.6+. Update from https://nodejs.org"
fi
say "Node.js v$NODE_VER found."

# ── 2. Download source ───────────────────────────────────────────────────────
say "Downloading FluxAgent from GitHub..."
mkdir -p "$APP_DIR"
TMP_TAR="$(mktemp /tmp/fluxagent-XXXXXX.tar.gz)"
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL" -o "$TMP_TAR" || die "download failed"
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_TAR" "$TARBALL" || die "download failed"
else
    die "need curl or wget to download"
fi
tar -xzf "$TMP_TAR" -C "$APP_DIR" --strip-components 1
rm -f "$TMP_TAR"
[ -f "$APP_DIR/src/cli/index.ts" ] || die "downloaded archive looks wrong (src/cli/index.ts missing)"
say "Source installed at $APP_DIR"

# ── 3. Shim ──────────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
SHIM="$BIN_DIR/fluxagent"
cat > "$SHIM" <<EOF
#!/usr/bin/env bash
exec node --experimental-strip-types "$APP_DIR/src/cli/index.ts" "\$@"
EOF
chmod +x "$SHIM"
say "Shim created: $SHIM"

# ── 4. PATH ──────────────────────────────────────────────────────────────────
case ":$PATH:" in
    *":$BIN_DIR:"*) say "PATH already contains $BIN_DIR." ;;
    *)
        PROFILE="$HOME/.bashrc"
        [ -n "${ZSH_VERSION:-}" ] && PROFILE="$HOME/.zshrc"
        if [ -f "$HOME/.profile" ] && [ ! -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.profile"; fi
        printf '\n# FluxAgent CLI\nexport PATH="$PATH:%s"\n' "$BIN_DIR" >> "$PROFILE"
        export PATH="$PATH:$BIN_DIR"
        say "Added $BIN_DIR to PATH via $PROFILE (open a new terminal to apply)."
        ;;
esac

# ── 5. Verify ────────────────────────────────────────────────────────────────
say "Verifying installation..."
if "$SHIM" version >/dev/null 2>&1; then
    say "Install complete! Run:"
    printf '\n    fluxagent doctor\n    fluxagent chat\n\n'
    printf 'Set a provider key first, e.g.:\n'
    printf '    export OPENAI_API_KEY=sk-...   (or ANTHROPIC_API_KEY, or OLLAMA_HOST=127.0.0.1:11434)\n'
else
    die "verification failed. Run '$SHIM version' to see the error."
fi
