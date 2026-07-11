#!/bin/sh
set -eu

fail() {
  printf 'Voxly TURN configuration error: %s\n' "$1" >&2
  exit 64
}

for name in TURN_REALM TURN_EXTERNAL_IP TURN_STATIC_AUTH_SECRET TURN_MIN_PORT TURN_MAX_PORT TURN_USER_QUOTA TURN_TOTAL_QUOTA; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || fail "$name is required"
done

[ "${#TURN_STATIC_AUTH_SECRET}" -ge 32 ] || fail "TURN_STATIC_AUTH_SECRET must contain at least 32 characters"
case "$TURN_REALM" in
  *[!A-Za-z0-9.-]*|.*|*.) fail "TURN_REALM must be a DNS hostname" ;;
esac

for name in TURN_MIN_PORT TURN_MAX_PORT TURN_USER_QUOTA TURN_TOTAL_QUOTA; do
  eval "value=\${$name}"
  case "$value" in
    ''|*[!0-9]*) fail "$name must be a positive integer" ;;
  esac
  [ "$value" -gt 0 ] || fail "$name must be greater than zero"
done

[ "$TURN_MIN_PORT" -le "$TURN_MAX_PORT" ] || fail "TURN_MIN_PORT must not exceed TURN_MAX_PORT"
[ "$TURN_MIN_PORT" -ge 1024 ] || fail "TURN_MIN_PORT must be at least 1024"
[ "$TURN_MAX_PORT" -le 65535 ] || fail "TURN_MAX_PORT must not exceed 65535"
relay_port_count=$((TURN_MAX_PORT - TURN_MIN_PORT + 1))
[ "$TURN_TOTAL_QUOTA" -le "$relay_port_count" ] || fail "TURN_TOTAL_QUOTA must not exceed the relay port count"

cert_dir="/run/turn-certs/live/$TURN_REALM"
[ -r "$cert_dir/fullchain.pem" ] || fail "TLS certificate is not readable at $cert_dir/fullchain.pem"
[ -r "$cert_dir/privkey.pem" ] || fail "TLS private key is not readable at $cert_dir/privkey.pem"

umask 077
config=/tmp/turnserver.conf
{
  printf 'realm=%s\n' "$TURN_REALM"
  printf 'server-name=%s\n' "$TURN_REALM"
  printf 'external-ip=%s\n' "$TURN_EXTERNAL_IP"
  printf 'static-auth-secret=%s\n' "$TURN_STATIC_AUTH_SECRET"
  printf 'listening-port=3478\n'
  printf 'tls-listening-port=5349\n'
  printf 'min-port=%s\n' "$TURN_MIN_PORT"
  printf 'max-port=%s\n' "$TURN_MAX_PORT"
  printf 'user-quota=%s\n' "$TURN_USER_QUOTA"
  printf 'total-quota=%s\n' "$TURN_TOTAL_QUOTA"
  printf 'cert=%s/fullchain.pem\n' "$cert_dir"
  printf 'pkey=%s/privkey.pem\n' "$cert_dir"
  printf '%s\n' fingerprint lt-cred-mech use-auth-secret no-cli no-multicast-peers simple-log new-log-timestamp
  printf 'log-file=stdout\n'
} > "$config"

exec turnserver -c "$config"
