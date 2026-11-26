#!/bin/sh
# Starts the relay (workerd), its TLS front (Caddy) and STUN (coturn); if one stops, the
# container stops, so Docker's restart policy brings all three back together.
set -eu
mkdir -p /data/relay /data/caddy/config /data/caddy/data
mode="${TLS_MODE:-internal}"
case "$mode" in
  internal)
    # Caddy's own CA, kept on the data volume; DOMAIN may be a LAN name or an IP address.
    # A client that connects to an IP address sends no SNI, and Caddy then had no certificate
    # to choose and answered with an internal-error alert (runner pairing looped at stage=tls).
    # default_sni only applies to such clients; a client that sends a hostname is unchanged.
    cat > /tmp/Caddyfile <<'CADDY'
{
  admin off
  persist_config off
  skip_install_trust
  auto_https disable_redirects
  default_sni {$DOMAIN:localhost}
}
https://{$DOMAIN:localhost}:{$HTTPS_PORT} {
  tls internal
  reverse_proxy 127.0.0.1:{$RELAY_PORT}
}
CADDY
    ;;
  certificate)
    { [ -n "${TLS_CERT:-}" ] && [ -n "${TLS_KEY:-}" ]; } || { echo 'TLS_CERT and TLS_KEY are required' >&2; exit 64; }
    cp /opt/pibot-relay/Caddyfile /tmp/Caddyfile
    ;;
  public)
    [ -n "${DOMAIN:-}" ] || { echo 'DOMAIN is required for public TLS' >&2; exit 64; }
    cat > /tmp/Caddyfile <<'CADDY'
{
  admin off
  persist_config off
}
{$DOMAIN}:{$HTTPS_PORT} {
  reverse_proxy 127.0.0.1:{$RELAY_PORT}
}
CADDY
    ;;
  *) echo 'TLS_MODE must be internal, certificate or public' >&2; exit 64 ;;
esac
cd /opt/pibot-relay
EXPO_ACCESS_TOKEN="${EXPO_ACCESS_TOKEN:-}" /usr/local/bin/workerd serve workerd.capnp &
relay_pid=$!
/usr/local/bin/caddy run --config /tmp/Caddyfile --adapter caddyfile &
caddy_pid=$!
stun_pid=
if [ "${ENABLE_STUN:-1}" = 1 ]; then
  # STUN only: no TURN relaying, no CLI, no TLS listeners, no user database.
  /usr/bin/turnserver --stun-only --no-cli --no-tls --no-dtls --no-auth \
    --listening-port="${STUN_PORT:-3478}" --no-stdout-log --log-file=stdout --simple-log \
    --db=/tmp/turndb --pidfile=/tmp/turnserver.pid &
  stun_pid=$!
fi
if [ "$mode" = internal ]; then
  root=/data/caddy/data/caddy/pki/authorities/local/root.crt
  i=0
  while [ ! -f "$root" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.2; done
  [ -f "$root" ] && echo "Pi Bot relay: internal CA certificate at $root (copy it to the computer and runners that use this relay)"
fi
pids="$relay_pid $caddy_pid $stun_pid"
trap 'kill $pids 2>/dev/null || true' INT TERM
while :; do
  for p in $pids; do kill -0 "$p" 2>/dev/null || { echo "Pi Bot relay: a process stopped ($p)" >&2; kill $pids 2>/dev/null || true; exit 1; }; done
  sleep 2
done
