#!/bin/sh
# Curl-installer for void.
#
# Usage:
#   curl -fsSL https://void-relay.com/install | sh
#
# Downloads the right binary for your platform, verifies SHA256,
# and installs to ~/.local/bin/void.

set -e

MANIFEST_URL="${VOID_MANIFEST_URL:-https://void-relay.com/release/latest.sh}"
DEST_DIR="${VOID_INSTALL_DIR:-$HOME/.local/bin}"
DEST="$DEST_DIR/void"

# --- detect platform ---
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
KEY="$(echo "${OS}_${ARCH}" | tr 'a-z' 'A-Z')"

# --- fetch manifest ---
eval "$(curl -fsSL "$MANIFEST_URL")"
eval "URL=\$VOID_${KEY}_URL"
eval "SHA=\$VOID_${KEY}_SHA"

if [ -z "$URL" ] || [ -z "$SHA" ]; then
  echo "no binary available for ${OS}-${ARCH}" >&2
  exit 1
fi

# --- download to a temp file ---
TMPDIR_LOCAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT
TARBALL="$TMPDIR_LOCAL/void.tar.gz"

echo "downloading void $VOID_VERSION ($OS-$ARCH)..."
curl -fsSL "$URL" -o "$TARBALL"

# --- verify sha256 ---
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TARBALL" | awk '{print $1}')"
else
  ACTUAL="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
fi
if [ "$ACTUAL" != "$SHA" ]; then
  echo "sha256 mismatch — aborting" >&2
  echo "  expected: $SHA" >&2
  echo "  actual:   $ACTUAL" >&2
  exit 1
fi

# --- extract + install ---
tar -xzf "$TARBALL" -C "$TMPDIR_LOCAL"
[ -x "$TMPDIR_LOCAL/void" ] || chmod +x "$TMPDIR_LOCAL/void"

# Strip macOS quarantine (defensive — binary is notarized but we'd rather
# avoid any chance of a first-run Gatekeeper prompt).
if [ "$OS" = "darwin" ]; then
  xattr -d com.apple.quarantine "$TMPDIR_LOCAL/void" >/dev/null 2>&1 || true
fi

mkdir -p "$DEST_DIR"
mv "$TMPDIR_LOCAL/void" "$DEST"

echo "installed void $VOID_VERSION to $DEST"

# --- ensure DEST_DIR is on PATH ---
#
# If DEST_DIR is already on PATH we're done. Otherwise we auto-append an
# `export PATH=...` line to the user's shell profile (idempotent), matching
# what bun / rustup / homebrew / fnm / uv etc. do. Users who don't want their
# profile modified can opt out with VOID_NO_PATH=1.
case ":$PATH:" in
  *":$DEST_DIR:"*)
    # Already on PATH, nothing to do.
    ;;
  *)
    if [ "${VOID_NO_PATH:-0}" = "1" ]; then
      echo ""
      echo "note: $DEST_DIR is not on your PATH; not modifying shell config"
      echo "      (VOID_NO_PATH=1 set). To run void:"
      echo "        $DEST"
    else
      shell_basename="$(basename "${SHELL:-/bin/sh}")"
      profile_file=""
      profile_line='export PATH="$HOME/.local/bin:$PATH"'
      case "$shell_basename" in
        zsh)
          profile_file="$HOME/.zshrc"
          ;;
        bash)
          # macOS bash users typically use ~/.bash_profile; Linux ~/.bashrc.
          if [ "$OS" = "darwin" ] && [ -f "$HOME/.bash_profile" ]; then
            profile_file="$HOME/.bash_profile"
          else
            profile_file="$HOME/.bashrc"
          fi
          ;;
        fish)
          profile_file="$HOME/.config/fish/config.fish"
          profile_line='set -gx PATH "$HOME/.local/bin" $PATH'
          ;;
      esac

      if [ -z "$profile_file" ]; then
        # Unrecognized shell — fall back to the old printed-instructions path.
        echo ""
        echo "note: $DEST_DIR is not on your PATH."
        echo "      add this to your shell profile:"
        echo "        $profile_line"
      elif [ -f "$profile_file" ] && grep -qF "$profile_line" "$profile_file" 2>/dev/null; then
        # Line is already there from a previous install.
        echo ""
        echo "$profile_file already exports $DEST_DIR on PATH."
        echo "open a new terminal or run:"
        echo "  source $profile_file"
        echo "then: void"
      else
        mkdir -p "$(dirname "$profile_file")"
        printf '\n# Added by the void installer (https://void-relay.com/install)\n%s\n' \
          "$profile_line" >> "$profile_file"
        echo ""
        echo "added $DEST_DIR to your PATH in $profile_file"
        echo "open a new terminal or run:"
        echo "  source $profile_file"
        echo "then: void"
      fi
    fi
    ;;
esac
