#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEV_DIR="$ROOT_DIR/.dev"
SAMPLE_DIR="$DEV_DIR/sample-workspace"
HOST_DATA="$DEV_DIR/host-user-data"
HOST_EXT="$DEV_DIR/host-extensions"
GUEST_DATA="$DEV_DIR/guest-user-data"
GUEST_EXT="$DEV_DIR/guest-extensions"

# Choose editor binary
EDITOR_BIN="${EDITOR_BIN:-}"
if [ -z "$EDITOR_BIN" ]; then
  if command -v antigravity >/dev/null 2>&1; then
    EDITOR_BIN="antigravity"
  elif command -v code >/dev/null 2>&1; then
    EDITOR_BIN="code"
  else
    echo "Error: neither 'antigravity' nor 'code' executable found in PATH." >&2
    exit 1
  fi
fi

echo "==> Using editor binary: $EDITOR_BIN"

# Prepare sample workspace
mkdir -p "$SAMPLE_DIR/src"
mkdir -p "$HOST_DATA" "$HOST_EXT" "$GUEST_DATA" "$GUEST_EXT"

cat <<'EOF' > "$SAMPLE_DIR/src/index.ts"
// CoLive Real-Time Collaboration Demo
export function greet(name: string): string {
  return `Hello, ${name}! Welcome to CoLive.`;
}

console.log(greet('World'));
EOF

cat <<'EOF' > "$SAMPLE_DIR/src/utils.ts"
export function add(a: number, b: number): number {
  return a + b;
}
EOF

# Secret file to prove exclusion
cat <<'EOF' > "$SAMPLE_DIR/.env"
# SENSITIVE ENVIRONMENT VARIABLES (MUST BE EXCLUDED)
DATABASE_URL="postgres://user:supersecret@localhost:5432/production"
SECRET_KEY="mock_sample_secret_key_for_testing"
EOF

# Symlink to prove sandboxing
ln -sfn /tmp "$SAMPLE_DIR/symlink-to-tmp" || true

echo "==> Sample workspace prepared at: $SAMPLE_DIR"

# Build all packages first
npm run build

# Start local relay server in background if not already listening on port 8787
if ! nc -z localhost 8787 2>/dev/null; then
  echo "==> Starting CoLive Relay Server on port 8787..."
  npm run dev:server &
  RELAY_PID=$!
  trap 'kill $RELAY_PID 2>/dev/null || true' EXIT
  sleep 1
else
  echo "==> Relay server is already running on port 8787."
fi

echo "======================================================================"
echo "MANUAL VERIFICATION CHECKLIST:"
echo "1. In HOST window: click 'Share Workspace' in CoLive sidebar or press Ctrl+Alt+L S."
echo "2. In GUEST window: click 'Join Session' or press Ctrl+Alt+L J and paste the invite code."
echo "3. In HOST window: approve the guest join request as Read & Write."
echo "4. In GUEST window: verify '.env' and 'symlink-to-tmp' are NOT visible or accessible."
echo "5. Open 'src/index.ts' in both windows: type concurrently and assert convergence."
echo "6. Verify remote carets, selection highlights, and name labels in both directions."
echo "7. In either window: right-click code, add an inline comment, reply, and resolve it."
echo "8. Test Follow Mode: click participant or Ctrl+Alt+L F; scroll host, guest follows."
echo "9. In HOST window: change guest permission to Read-Only; verify guest cannot type."
echo "10. In HOST window: click 'End Session'; verify guest workspace folder is removed."
echo "======================================================================"

# Launch Host instance
"$EDITOR_BIN" \
  --user-data-dir "$HOST_DATA" \
  --extensions-dir "$HOST_EXT" \
  --extensionDevelopmentPath="$ROOT_DIR/packages/extension" \
  "$SAMPLE_DIR" &

# Launch Guest instance (empty workspace initially)
"$EDITOR_BIN" \
  --user-data-dir "$GUEST_DATA" \
  --extensions-dir "$GUEST_EXT" \
  --extensionDevelopmentPath="$ROOT_DIR/packages/extension" &

wait
