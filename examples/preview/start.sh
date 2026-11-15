#!/usr/bin/env bash
# One machine, three processes, for a demo: the card-terminal simulator (on the loopback address only, so nothing
# outside the machine reaches it), the worker and the API. PAYMENT_SIMULATOR_URL must be http://127.0.0.1:4010.
# When any one of them exits, the others are stopped and the script exits with its status, so the platform restarts
# the whole machine instead of running an API without a worker.
cd /app/packages/server || exit 1
node dist/payment-simulator.js --port 4010 --api "http://127.0.0.1:${PORT:-8080}" &
node dist/index.js --role=worker &
node dist/index.js --role=app &

stop() {
  kill -TERM $(jobs -p) 2>/dev/null
  wait
}
trap 'stop; exit 0' TERM INT
wait -n
status=$?
stop
exit "$status"
