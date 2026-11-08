#!/usr/bin/env bash
# Real concurrent sessions against apply_op. Runs after the (rolled-back) SQL tests, on committed fixtures.
# usage: concurrency.sh <port> <dbname> <tests-dir>
set -euo pipefail
PORT=$1; DB=$2; HERE=$3
q() { psql -h 127.0.0.1 -p "$PORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
q -f "$HERE/fixtures.sql" >/dev/null
q -c "select test.new_audit(test.u(901))" >/dev/null

INST1=$(q -c "select test.u(4)")
# Every worker connects, then blocks on a shared advisory lock until the gate holder (exclusive lock + sleep) ends,
# so all workers hit apply_op at the same instant instead of one after another.
as_inst1() {
  q -c "set role authenticated; select set_config('request.jwt.claim.sub', '$INST1', false); select pg_advisory_lock_shared(777)::text; select public.apply_op('$1'::jsonb) ->> 'status'" 2>&1 | tail -1
}
open_gate() { q -c "select pg_advisory_lock(777); select pg_sleep(${GATE_SECONDS:-3})" >/dev/null & sleep 0.4; }

# A) 10 concurrent sessions replay the SAME opId -> exactly one applied, the rest duplicates, one measurement.
OP=$(q -c "select test.op(1, 'audit_item', test.u(901) || ':1:wall_length', 0, '{\"actual64\":7700,\"expected64\":7680,\"drawingRef\":\"A\"}', test.u(4))")
open_gate
res=$(for i in $(seq 1 10); do as_inst1 "$OP" & done; wait)
applied=$(echo "$res" | grep -c '^applied$' || true); dup=$(echo "$res" | grep -c '^duplicate$' || true)
meas=$(q -c "select count(*) from public.measurements where audit_id = test.u(901)")
ops=$(q -c "select count(*) from public.applied_ops where op_id = test.u(1001)")
echo "same opId x10: applied=$applied duplicate=$dup measurements=$meas applied_ops=$ops"
[ "$applied" = 1 ] && [ "$dup" = 9 ] && [ "$meas" = 1 ] && [ "$ops" = 1 ] || { echo "FAILED: concurrent replay of one opId"; exit 1; }

# B) 10 concurrent DIFFERENT opIds from the same stale base version -> exactly one applied, the rest conflict.
open_gate
res=$(for i in $(seq 11 20); do
  OPi=$(q -c "select test.op($i, 'audit_item', test.u(901) || ':1:ceiling_height', 0, '{\"actual64\":6144,\"expected64\":6144,\"drawingRef\":\"A\"}', test.u(4))")
  as_inst1 "$OPi" & done; wait)
applied=$(echo "$res" | grep -c '^applied$' || true); conf=$(echo "$res" | grep -c '^conflict$' || true)
meas=$(q -c "select count(*) from public.measurements where audit_id = test.u(901) and item_key = 'ceiling_height'")
echo "different opIds, same base x10: applied=$applied conflict=$conf measurements=$meas"
[ "$applied" = 1 ] && [ "$conf" = 9 ] && [ "$meas" = 1 ] || { echo "FAILED: concurrent writes from a stale base"; exit 1; }
echo "ok - concurrency: replay of one opId applies once; stale-base writers conflict (2 scenarios)"
