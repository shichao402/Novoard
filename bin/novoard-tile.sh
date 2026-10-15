#!/bin/bash
# macOS 快捷指令磁贴（M1 · PRD-5 F4）
# 等价物：原 iOS Shortcuts 磁贴 → macOS 桌面双击磁贴（.command 文件）
# 用途：一键 POST /api/trigger（fire-and-forget），终态经企微通知扇出
#
# ── 配置区 ─────────────────────────────────────────────
HUB_URL="${NOVOARD_HUB_URL:-https://novoard.firoyang.com}"
TARGET="${NOVOARD_TARGET:-dev-build-investm}"
MEMBER="${NOVOARD_MEMBER:-}"   # 缺省=查表自动选在线成员
PAT_FILE="${NOVOARD_PAT_FILE:-${HOME}/.config/novoard/pat}"
PAT="${NOVOARD_PAT:-}"
[ -z "${PAT}" ] && [ -r "${PAT_FILE}" ] && PAT=$(cat "${PAT_FILE}")

if [ -z "${PAT}" ]; then
  osascript -e 'display notification "缺少具名 PAT；请配置 ~/.config/novoard/pat" with title "Novoard 磁贴"'
  exit 1
fi

# ── 触发（fire-and-forget）─────────────────────────────
BODY="{\"target\":\"${TARGET}\""
[ -n "${MEMBER}" ] && BODY="${BODY},\"member\":\"${MEMBER}\""
BODY="${BODY}}"

RESP=$(curl -s -w '\n%{http_code}' --max-time 10 \
  -X POST "${HUB_URL}/api/trigger" \
  -H 'Content-Type: application/json' \
  -d "${BODY}" \
  --config - <<EOF
header = "Authorization: Bearer ${PAT}"
EOF
)

HTTP=$(echo "${RESP}" | tail -1)
JSON=$(echo "${RESP}" | sed '$d')

# ── 通知（等价 iOS「显示通知」动作）────────────────────
TITLE="Novoard 磁贴"
if [ "${HTTP}" = "202" ]; then
  STATE=$(echo "${JSON}" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("state","?"))' 2>/dev/null)
  REASON=$(echo "${JSON}" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason",""))' 2>/dev/null)
  if [ "${STATE}" = "submitted" ]; then
    osascript -e "display notification \"任务已受理，终态经企微通知送达\" with title \"${TITLE}\" subtitle \"${TARGET}\""
  elif [ "${STATE}" = "rejected" ]; then
    osascript -e "display notification \"离线拒绝：${REASON}，任务未入队\" with title \"${TITLE}\" subtitle \"${TARGET}\""
  fi
else
  osascript -e "display notification \"触发失败 HTTP ${HTTP}\" with title \"${TITLE}\" subtitle \"${TARGET}\""
fi
