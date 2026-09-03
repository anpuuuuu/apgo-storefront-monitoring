#!/usr/bin/env bash
set -eu
# A simulated failure must fail the run, but must make no CF/Telegram request.
curl() { echo 'unexpected-network' >&2; return 99; }
export -f curl
set +e
output=$(MONITOR_MODE=shadow FORCE_FAIL=true CF_API_TOKEN=fake CF_ACCOUNT_ID=fake TELEGRAM_BOT_TOKEN=fake TELEGRAM_CHAT_ID=fake bash scripts/uptime-check.sh 2>&1)
code=$?
set -e
[[ "$code" = 1 ]]
[[ "$output" == *'Telegram notification suppressed'* ]]
[[ "$output" != *'unexpected-network'* ]]
echo 'PASS: Shadow uptime fails a simulated outage without state/Telegram network writes.'
