#!/usr/bin/env bash
set -euo pipefail

NAME=pillow-pg

if ! docker info > /dev/null 2>&1; then
  echo "docker daemon not running — start Docker Desktop and retry" >&2
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "${NAME} already running"
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "starting existing ${NAME}"
  docker start "${NAME}" > /dev/null
else
  echo "creating and starting ${NAME}"
  docker run -d --name "${NAME}" \
    -p 5432:5432 \
    -e POSTGRES_PASSWORD=dev \
    -v pillow-pg-data:/var/lib/postgresql/data \
    postgres:16 > /dev/null
fi

echo "waiting for postgres to accept connections..."
until docker exec "${NAME}" pg_isready -U postgres > /dev/null 2>&1; do
  sleep 0.5
done
echo "${NAME} ready on 127.0.0.1:5432"
