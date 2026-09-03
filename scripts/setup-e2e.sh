#!/usr/bin/env bash
#
# Prepares the Joplin desktop build used by the real-app E2E tests: extracts an AppImage into
# .e2e-cache/squashfs-root/ so the tests can spawn Joplin's own bundled Electron directly.
# Idempotent: skips the copy/download/extract if the extracted Electron binary already exists.
#
# Two ways to supply the AppImage:
#   JOPLIN_E2E_APPIMAGE=/path/to/Joplin.AppImage   copy a local AppImage (no network)
#   JOPLIN_E2E_VERSION=3.7.14                      download that version from GitHub releases
#
set -euo pipefail

# 3.7.14 is the build this plugin is developed and verified against, and the version installed on
# the developer's own desktop. Whereabouts injects into Joplin's PRIVATE note-title DOM, so the E2E
# must run against a real Joplin of a known version — the selectors are only guaranteed for 3.7+.
JOPLIN_VERSION="${JOPLIN_E2E_VERSION:-3.7.14}"
# Optional local AppImage, copied instead of downloaded. Set this to the AppImage already on disk
# (e.g. ~/.joplin/Joplin.AppImage) to avoid a 200MB download on every clean checkout.
LOCAL_APPIMAGE="${JOPLIN_E2E_APPIMAGE:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.e2e-cache"
APPIMAGE="$CACHE_DIR/Joplin.AppImage"
BINARY="$CACHE_DIR/squashfs-root/joplin"
URL="https://github.com/laurent22/joplin/releases/download/v${JOPLIN_VERSION}/Joplin-${JOPLIN_VERSION}.AppImage"

mkdir -p "$CACHE_DIR"

if [ -x "$BINARY" ]; then
  echo "[setup-e2e] Joplin already extracted at $BINARY — nothing to do."
  exit 0
fi

if [ ! -f "$APPIMAGE" ] && [ -n "$LOCAL_APPIMAGE" ]; then
  if [ ! -f "$LOCAL_APPIMAGE" ]; then
    echo "[setup-e2e] ERROR: JOPLIN_E2E_APPIMAGE=$LOCAL_APPIMAGE does not exist" >&2
    exit 1
  fi
  echo "[setup-e2e] Copying local AppImage from $LOCAL_APPIMAGE ..."
  cp "$LOCAL_APPIMAGE" "$APPIMAGE"
  chmod +x "$APPIMAGE"
fi

if [ ! -f "$APPIMAGE" ]; then
  echo "[setup-e2e] Downloading Joplin $JOPLIN_VERSION ..."
  # -f: fail (non-zero exit) on an HTTP error such as a 404 for a mistyped/withdrawn version, rather
  # than silently saving the error page as "Joplin.AppImage" and failing confusingly at extract time.
  # --retry: ride out transient network/CDN blips. rm on failure so a partial file is not cached.
  if ! curl -fSL --retry 3 --retry-delay 2 -o "$APPIMAGE" "$URL"; then
    echo "[setup-e2e] ERROR: failed to download Joplin $JOPLIN_VERSION from $URL" >&2
    rm -f "$APPIMAGE"
    exit 1
  fi
  # A valid AppImage is well over 100 MB; anything tiny is an error page that slipped through.
  if [ "$(stat -c%s "$APPIMAGE" 2>/dev/null || echo 0)" -lt 10000000 ]; then
    echo "[setup-e2e] ERROR: downloaded AppImage is implausibly small — treating as a failed download" >&2
    rm -f "$APPIMAGE"
    exit 1
  fi
  chmod +x "$APPIMAGE"
fi

echo "[setup-e2e] Extracting AppImage (no FUSE required) ..."
( cd "$CACHE_DIR" && "$APPIMAGE" --appimage-extract >/dev/null )

if [ ! -x "$BINARY" ]; then
  echo "[setup-e2e] ERROR: expected Electron binary not found at $BINARY" >&2
  exit 1
fi

echo "[setup-e2e] Ready: $BINARY"
