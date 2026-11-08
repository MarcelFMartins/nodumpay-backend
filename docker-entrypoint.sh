#!/bin/sh
set -e
if [ "${SKIP_MIGRATIONS:-false}" != "true" ]; then
  echo "Aplicando migrações..."
  prisma migrate deploy --schema=./prisma/schema.prisma
fi
exec node server.js
