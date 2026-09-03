#!/usr/bin/env bash
# APGO Layer 1: lightweight uptime probe, run every ~10 min by uptime.yml.
# Pure curl + jq — no npm, no browser. A failing check is re-tried once after
# recheck_delay_s so a single edge blip never alerts.
#
# State (up/down, last alert time) lives in Cloudflare D1 so a hard-down site
# re-alerts every realert_minutes instead of every 10 minutes, and recovery
# gets announced. Fail-open by design: if D1 or its secrets are unavailable
# the probe still alerts — worst case duplicates, never silence.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/config/alerts-config.json"
SITES="$ROOT/config/sites.json"

TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TG_CHAT="${TELEGRAM_CHAT_ID:-}"
CF_TOKEN="${CF_API_TOKEN:-}"
CF_ACCOUNT="${CF_ACCOUNT_ID:-}"
RUN_URL="${RUN_URL:-}"
FORCE_FAIL="${FORCE_FAIL:-false}"
MONITOR_MODE="${MONITOR_MODE:-shadow}"
case "$MONITOR_MODE" in live|shadow) ;; *) echo 'Invalid MONITOR_MODE'; exit 2 ;; esac
FAILED=0

DB_ID="$(jq -r '.cloudflare.database_id // empty' "$CONFIG")"
RECHECK_DELAY="$(jq -r '.uptime.recheck_delay_s // 30' "$CONFIG")"
REALERT_MIN="$(jq -r '.uptime.realert_minutes // 60' "$CONFIG")"
UA='Mozilla/5.0 (compatible; APGO-HealthCheck-Uptime)'

STATELESS=0
if [ "$MONITOR_MODE" = shadow ]; then
  STATELESS=1
  echo 'Shadow diagnostic: production state and Telegram writes disabled.'
fi
if [ -z "$CF_TOKEN" ] || [ -z "$CF_ACCOUNT" ] || [ -z "$DB_ID" ]; then
  echo "::notice::CF_API_TOKEN/CF_ACCOUNT_ID 未设定 — 无状态模式(持续宕机会重复告警、无恢复通知)"
  STATELESS=1
fi

# --- helpers ---------------------------------------------------------------

d1_query() { # $1 sql, $2 json params array; prints result rows, non-zero on failure
  local resp
  resp=$(curl -sS --max-time 15 -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${DB_ID}/query" \
    -H "Authorization: Bearer ${CF_TOKEN}" -H 'Content-Type: application/json' \
    --data "$(jq -cn --arg sql "$1" --argjson params "${2:-[]}" '{sql:$sql,params:$params}')") || return 1
  echo "$resp" | jq -e '.success == true' >/dev/null 2>&1 || return 1
  echo "$resp" | jq -c '.result[0].results // []'
}

tg_send() { # $1 message text
  if [ "$MONITOR_MODE" = shadow ]; then
    echo 'Shadow: Telegram notification suppressed.'
    return 0
  fi
  if [ -z "$TG_TOKEN" ] || [ -z "$TG_CHAT" ]; then
    echo "::warning::TELEGRAM secrets 未设定,以下通知未发出:"
    echo "$1"
    return 0
  fi
  curl -sS --max-time 15 "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=$1" \
    --data-urlencode 'disable_web_page_preview=true' >/dev/null \
    || echo "::warning::Telegram 发送失败"
}

log_alert() { # $1 kind, $2 detail json
  [ "$STATELESS" = 1 ] && return 0
  d1_query "INSERT INTO alert_log (layer, kind, detail) VALUES ('uptime', ?1, ?2)" \
    "$(jq -cn --arg k "$1" --arg d "$2" '[$k, $d]')" >/dev/null || true
}

save_state() { # $1 key, $2 value json
  [ "$STATELESS" = 1 ] && return 0
  d1_query "INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')" \
    "$(jq -cn --arg k "$1" --arg v "$2" '[$k, $v]')" >/dev/null \
    || echo "::warning::写入状态失败: $1"
}

check_site() { # $1 baseUrl, $2 type; prints failure reason, empty = OK
  local base="$1" type="$2" code body
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -A "$UA" -L "$base/" 2>/dev/null) || { echo "首页请求失败(连不上)"; return 0; }
  case "$code" in
    2*|3*) : ;;
    *) echo "首页 HTTP $code"; return 0 ;;
  esac
  if [ "$type" = "shopify" ]; then
    body=$(curl -sS --max-time 20 -A "$UA" "$base/cart.js" 2>/dev/null) || { echo "/cart.js 请求失败"; return 0; }
    echo "$body" | jq -e 'has("item_count")' >/dev/null 2>&1 || { echo "/cart.js 返回异常(非预期 JSON)"; return 0; }
  fi
  return 0
}

# --- main ------------------------------------------------------------------

NOW_EPOCH=$(date +%s)
NOW_MYT=$(TZ='Asia/Kuala_Lumpur' date '+%Y-%m-%d %H:%M')

while read -r site; do
  id=$(echo "$site" | jq -r '.id')
  name=$(echo "$site" | jq -r '.name // .id')
  base=$(echo "$site" | jq -r '.baseUrl')
  type=$(echo "$site" | jq -r '.type // "shopify"')
  [ -z "$base" ] && continue

  if [ "$FORCE_FAIL" = "true" ]; then
    reason="手动测试(force_fail)"
  else
    reason=$(check_site "$base" "$type")
    if [ -n "$reason" ]; then
      echo "$id: 第一次检查失败($reason),${RECHECK_DELAY}s 后复查..."
      sleep "$RECHECK_DELAY"
      reason=$(check_site "$base" "$type")
    fi
  fi

  # previous state
  prev_status="unknown"; prev_since=""; prev_since_epoch=0; prev_last_alert=0
  if [ "$STATELESS" = 0 ]; then
    if row=$(d1_query "SELECT value FROM state WHERE key = ?1" "$(jq -cn --arg k "uptime:$id" '[$k]')"); then
      if [ "$row" != "[]" ] && [ -n "$row" ]; then
        val=$(echo "$row" | jq -r '.[0].value')
        prev_status=$(echo "$val" | jq -r '.status // "unknown"')
        prev_since=$(echo "$val" | jq -r '.since // ""')
        prev_since_epoch=$(echo "$val" | jq -r '.since_epoch // 0')
        prev_last_alert=$(echo "$val" | jq -r '.last_alert_at // 0')
      fi
    else
      echo "::warning::读取状态失败,本轮按无历史处理"
    fi
  fi

  if [ -n "$reason" ]; then
    FAILED=1
    echo "::error::$id DOWN: $reason"
    if [ "$prev_status" = "down" ]; then
      age_min=$(( (NOW_EPOCH - prev_last_alert) / 60 ))
      if [ "$prev_last_alert" -gt 0 ] && [ "$age_min" -lt "$REALERT_MIN" ]; then
        echo "$id: 距上次告警 ${age_min} 分钟(<${REALERT_MIN}),不重复通知"
        continue
      fi
      tg_send "🔴 [第1层·拨测] ${name} 仍然宕机
自 ${prev_since:-未知} (MYT) 起持续无法访问
本轮原因: ${reason}
${RUN_URL}"
      save_state "uptime:$id" "$(jq -cn --arg s "$prev_since" --argjson se "$prev_since_epoch" --argjson t "$NOW_EPOCH" '{status:"down",since:$s,since_epoch:$se,last_alert_at:$t}')"
      log_alert "realert" "$(jq -cn --arg id "$id" --arg r "$reason" '{site:$id,reason:$r}')"
    else
      tg_send "🔴 [第1层·拨测] ${name} 疑似宕机
检查失败: ${reason}
(${RECHECK_DELAY} 秒后复查仍失败;每小时的真浏览器巡检会给出更多细节)
时间: ${NOW_MYT} (MYT)
${RUN_URL}"
      save_state "uptime:$id" "$(jq -cn --arg s "$NOW_MYT" --argjson se "$NOW_EPOCH" --argjson t "$NOW_EPOCH" '{status:"down",since:$s,since_epoch:$se,last_alert_at:$t}')"
      log_alert "alert" "$(jq -cn --arg id "$id" --arg r "$reason" '{site:$id,reason:$r}')"
    fi
  else
    echo "$id: OK"
    if [ "$prev_status" = "down" ]; then
      down_min="?"
      [ "$prev_since_epoch" -gt 0 ] && down_min=$(( (NOW_EPOCH - prev_since_epoch) / 60 ))
      tg_send "✅ [第1层·拨测] ${name} 已恢复
宕机开始: ${prev_since:-未知} (MYT)
恢复时间: ${NOW_MYT} (MYT),本次宕机约 ${down_min} 分钟"
      save_state "uptime:$id" '{"status":"up"}'
      log_alert "recovery" "$(jq -cn --arg id "$id" --argjson m "${down_min/\?/0}" '{site:$id,down_minutes:$m}')"
    elif [ "$prev_status" != "up" ]; then
      save_state "uptime:$id" '{"status":"up"}'
    fi
  fi
done < <(jq -c '.sites[] | select(.enabled == true)' "$SITES")

exit "$FAILED"
