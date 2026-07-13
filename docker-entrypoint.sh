#!/bin/sh
set -e

mkdir -p /app/.tms/repository
mkdir -p /app/.tms/kdm-auto-download/downloads

exec "$@"
