#!/bin/sh
set -eu

fail() {
  printf 'Voxly TURN certificate export error: %s\n' "$1" >&2
  exit 64
}

realm=${1:-${TURN_REALM:-}}
source_root=${2:-${TURN_CERT_SOURCE_ROOT:-/etc/letsencrypt}}
destination_root=${3:-${TURN_CERT_DIR:-/opt/voxly/secrets/turn}}
image=${TURN_IMAGE:-coturn/coturn:4.14.0-r0}

[ -n "$realm" ] || fail "pass the TURN realm as the first argument or set TURN_REALM"
[ "$(id -u)" -eq 0 ] || fail "run this script as root so it can read the ACME private key"

source_dir="$source_root/live/$realm"
[ -r "$source_dir/fullchain.pem" ] || fail "certificate is not readable at $source_dir/fullchain.pem"
[ -r "$source_dir/privkey.pem" ] || fail "private key is not readable at $source_dir/privkey.pem"

if [ -n "${TURN_CERT_GROUP:-}" ]; then
  certificate_group=$TURN_CERT_GROUP
else
  command -v docker >/dev/null 2>&1 || fail "docker is required to discover the Coturn group; alternatively set TURN_CERT_GROUP"
  certificate_group=$(docker run --rm --entrypoint id "$image" -g) || fail "could not discover the Coturn container group"
fi

case "$certificate_group" in
  ''|*[!0-9]*) fail "TURN_CERT_GROUP must be a numeric group id" ;;
esac

destination_dir="$destination_root/live/$realm"
install -d -m 0750 -o root -g "$certificate_group" \
  "$destination_root" "$destination_root/live" "$destination_dir"

certificate_tmp="$destination_dir/.fullchain.pem.$$"
private_key_tmp="$destination_dir/.privkey.pem.$$"
trap 'rm -f "$certificate_tmp" "$private_key_tmp"' EXIT HUP INT TERM

install -m 0640 -o root -g "$certificate_group" "$source_dir/fullchain.pem" "$certificate_tmp"
install -m 0640 -o root -g "$certificate_group" "$source_dir/privkey.pem" "$private_key_tmp"
mv -f "$certificate_tmp" "$destination_dir/fullchain.pem"
mv -f "$private_key_tmp" "$destination_dir/privkey.pem"

printf 'Exported TURN certificate to %s for container group %s\n' "$destination_dir" "$certificate_group"
