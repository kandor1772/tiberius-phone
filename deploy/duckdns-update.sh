#!/bin/sh
set -eu

if [ -z "${DUCKDNS_TOKEN:-}" ]; then
  echo "DUCKDNS_TOKEN is required" >&2
  exit 1
fi

DOMAIN="${DUCKDNS_DOMAIN:-eltiburon}"
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${DUCKDNS_TOKEN}&ip="
echo
