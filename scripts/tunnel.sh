#!/usr/bin/env bash
set -e

# ==============================================================================
# CoLive Cloudflare Tunnel Runner
# Exposes the local CoLive relay server securely to the worldwide web using
# a free, zero-config Cloudflare Tunnel (TryCloudflare).
# ==============================================================================

WORKSPACE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PORT="${PORT:-8787}"
TUNNEL_LOG="/tmp/colive-cloudflared-$$.log"
TUNNEL_URL_FILE="$WORKSPACE_ROOT/.tunnel-url"

cleanup() {
  echo -e "\n\033[1;33m[CoLive] Shutting down Cloudflare Tunnel and Relay...\033[0m"
  if [ -n "$CLOUDFLARED_PID" ] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    kill "$CLOUDFLARED_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_LOG" "$TUNNEL_URL_FILE"
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# 1. Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
  echo -e "\033[1;31m[Error] 'cloudflared' binary not found in PATH.\033[0m"
  echo "Please install it via: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
  exit 1
fi

echo -e "\033[1;36m=========================================================\033[0m"
echo -e "\033[1;36m       CoLive Worldwide Collaboration via Cloudflare     \033[0m"
echo -e "\033[1;36m=========================================================\033[0m"

# 2. Check if relay server is running on port $SERVER_PORT; if not, build & start it
if ! nc -z 127.0.0.1 "$SERVER_PORT" 2>/dev/null && ! curl -s --noproxy '*' "http://127.0.0.1:$SERVER_PORT/health" &> /dev/null; then
  echo -e "\033[1;34m[1/3] Building & starting local CoLive relay server on port $SERVER_PORT...\033[0m"
  (cd "$WORKSPACE_ROOT/packages/server" && npm run build > /dev/null 2>&1)
  node "$WORKSPACE_ROOT/packages/server/dist/index.js" &
  SERVER_PID=$!
  sleep 1.5
else
  echo -e "\033[1;32m[1/3] Local CoLive relay server already running on port $SERVER_PORT.\033[0m"
fi

# 3. Start Cloudflare Tunnel
echo -e "\033[1;34m[2/3] Establishing Cloudflare Tunnel to port $SERVER_PORT...\033[0m"
cloudflared tunnel --url "http://127.0.0.1:$SERVER_PORT" > "$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID=$!

# 4. Wait for Cloudflare to assign public URL
echo -n "Waiting for public trycloudflare.com endpoint..."
TUNNEL_URL=""
for i in {1..30}; do
  if [ -f "$TUNNEL_LOG" ]; then
    TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n 1 || true)
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  fi
  echo -n "."
  sleep 1
done
echo ""

if [ -z "$TUNNEL_URL" ]; then
  echo -e "\033[1;31m[Error] Failed to obtain Cloudflare Tunnel URL. Check log:\033[0m"
  cat "$TUNNEL_LOG"
  exit 1
fi

WS_URL="${TUNNEL_URL/https:\/\//wss:\/\/}/ws"

# Save tunnel URL for extension auto-discovery
echo "$WS_URL" > "$TUNNEL_URL_FILE"

echo -e "\033[1;32m[3/3] Cloudflare Tunnel Established Successfully! 🌍\033[0m\n"
echo -e "========================================================="
echo -e " \033[1mPUBLIC WEB URL\033[0m       : \033[1;32m$TUNNEL_URL\033[0m"
echo -e " \033[1mEXTENSION WS URL\033[0m     : \033[1;32m$WS_URL\033[0m"
echo -e " \033[1mHEALTH ENDPOINT\033[0m      : \033[1;34m$TUNNEL_URL/health\033[0m"
echo -e "=========================================================\n"

echo -e "\033[1mHow to use worldwide:\033[0m"
echo -e "1. In VS Code / Antigravity Settings (settings.json), set:"
echo -e "   \033[1;33m\"colive.serverUrl\": \"$WS_URL\"\033[0m"
echo -e "   (Or run Command: \033[1mCoLive: Set Cloudflare Tunnel URL\033[0m and paste above)"
echo -e "2. Click \033[1m'Share'\033[0m in your editor status bar to create a session."
echo -e "3. Send the invite link to anyone worldwide — they can join instantly!\n"
echo -e "\033[90mPress Ctrl+C to close the tunnel and stop.\033[0m"

# Keep script running
wait "$CLOUDFLARED_PID"
