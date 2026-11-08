#!/usr/bin/env bash
# Applies every migration in supabase/migrations to a throwaway local Postgres 16 (with test-only Supabase
# stand-ins from 00_stub.sql), loads supabase/seed.sql, then runs each supabase/tests/NN_*.sql file.
# Nothing here touches a remote Supabase project.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=${PHC_PGDATA:-/var/lib/postgresql/phc-pgtest}
PORT=${PHC_PGPORT:-54329}
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

if [ ! -d "$DATA" ]; then as_pg "$PGBIN/initdb" -D "$DATA" -A trust -U postgres >/dev/null; fi
if ! as_pg "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  as_pg "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c fsync=off -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start >/dev/null
fi
psqlc() { psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psqlc -d postgres -c "drop database if exists phc_test with (force)" -c "create database phc_test" >/dev/null
echo "== stub";  psqlc -d phc_test -f "$here/00_stub.sql" >/dev/null
for f in "$root"/migrations/*.sql; do echo "== migration $(basename "$f")"; psqlc -d phc_test -f "$f" >/dev/null; done
echo "== seed";  psqlc -d phc_test -f "$root/seed.sql" >/dev/null

total=0
for t in "$here"/[0-9][0-9]_*.sql; do
  [ "$(basename "$t")" = "00_stub.sql" ] && continue
  echo "== test $(basename "$t")"
  out=$(psqlc -d phc_test -f "$t" 2>&1) || { echo "$out" | sed 's/^psql:[^ ]* //'; echo "FAILED: $(basename "$t")"; exit 1; }
  n=$(echo "$out" | grep -c "NOTICE:  ok - " || true)
  echo "$out" | sed -n 's/^psql:[^ ]* NOTICE:  //p'
  total=$((total + n))
done
echo "== concurrency (real parallel sessions)"
"$here/concurrency.sh" "$PORT" phc_test "$here"
echo "PASSED: $total assertions + concurrency checks"
