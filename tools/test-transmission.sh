#!/bin/sh
# Спайк: проверяем что Transmission RPC на Кинетике принимает запросы плагина.
# Эмулируем те же шаги, что будет делать LAMPA-плагин:
#   1. POST /transmission/rpc без session-id  → ждем 409 + X-Transmission-Session-Id.
#   2. POST с session-id и (опц.) basic-auth → ждем 200 + {"result":"success"}.
#   3. torrent-add с тестовым magnet (paused, чтобы не качалось зря).
#
# Запуск на Кинетике (через SSH, нужен curl из Entware):
#   sh test-transmission.sh                                            # дефолт 127.0.0.1:8091, без auth
#   sh test-transmission.sh 127.0.0.1:8091                             # явный host:port
#   sh test-transmission.sh 127.0.0.1:8091 USER PASS                   # с авторизацией
#   sh test-transmission.sh 127.0.0.1:8091 "" "" "magnet:?xt=urn:..."  # свой magnet
#
# Запуск с Mac (если Кинетик в LAN и RPC слушает на LAN-интерфейсе):
#   sh test-transmission.sh 192.168.1.1:8091
#
# Если на шаге 3 хочешь чтобы скачивание реально шло — убери `"paused":true`.

set -eu

HOST="${1:-127.0.0.1:8091}"
USER_NAME="${2:-}"
USER_PASS="${3:-}"
# Magnet передается параметром. Дефолта НЕТ намеренно: лучше пропустить шаг 3,
# чем подсунуть неизвестную раздачу. Шаги 1-2 (probe + auth) прогоняются всегда.
MAGNET="${4:-}"

RPC_URL="http://${HOST}/transmission/rpc"
AUTH_ARGS=""
if [ -n "$USER_NAME" ]; then
    AUTH_ARGS="-u ${USER_NAME}:${USER_PASS}"
fi

# Проверяем что curl доступен (на Entware: /opt/bin/curl).
if ! command -v curl >/dev/null 2>&1; then
    echo "FAIL: curl не найден. Установи opkg install curl или используй /opt/bin/curl."
    exit 127
fi

echo "RPC: $RPC_URL"
[ -n "$AUTH_ARGS" ] && echo "Auth: basic ($USER_NAME / ***)" || echo "Auth: нет"
echo

# ---------- Шаг 1: probe ----------
# Стандартный Transmission отвечает 409 + X-Transmission-Session-Id.
# Сборка Кинетика отдает 200 OK сразу — CSRF отключен. Оба варианта валидны.
echo "=== 1. Probe session-stats ==="
PROBE_OUT=$(curl -s -i -X POST "$RPC_URL" $AUTH_ARGS \
    -H 'Content-Type: application/json' \
    -d '{"method":"session-stats"}' 2>&1) || true

STATUS_LINE=$(printf '%s\n' "$PROBE_OUT" | head -n 1 | tr -d '\r')
echo "Status: $STATUS_LINE"

SESS_ID=$(printf '%s\n' "$PROBE_OUT" \
    | tr -d '\r' \
    | awk 'tolower($1) == "x-transmission-session-id:" { print $2; exit }')

HAS_SUCCESS=0
case "$PROBE_OUT" in *'"result":"success"'*) HAS_SUCCESS=1 ;; esac

if [ -n "$SESS_ID" ]; then
    echo "Session-Id: $SESS_ID  (CSRF включен — стандартный Transmission)"
    SESS_HEADER_ARG="-H X-Transmission-Session-Id:$SESS_ID"
elif [ "$HAS_SUCCESS" = 1 ]; then
    echo "Session-Id: (не нужен — CSRF отключен в этой сборке Transmission)"
    SESS_HEADER_ARG=""
else
    case "$PROBE_OUT" in
        *'HTTP/1.1 401'*|*'HTTP/1.0 401'*)
            echo "FAIL: 401 Unauthorized. Проверь логин/пароль."
            ;;
        *)
            echo "FAIL: непонятный ответ."
            ;;
    esac
    echo
    echo "Полный ответ:"
    printf '%s\n' "$PROBE_OUT" | head -n 40
    exit 1
fi
echo

# ---------- Шаг 2: session-stats повторно с session-id (если был выдан) ----------
if [ -n "$SESS_ID" ]; then
    echo "=== 2. session-stats с session-id (retry) ==="
    STATS_OUT=$(curl -s -w '\nHTTP-STATUS:%{http_code}\n' -X POST "$RPC_URL" $AUTH_ARGS \
        -H 'Content-Type: application/json' \
        $SESS_HEADER_ARG \
        -d '{"method":"session-stats"}')
    echo "$STATS_OUT" | head -c 600
    echo
    case "$STATS_OUT" in
        *'"result":"success"'*) echo "OK." ;;
        *'HTTP-STATUS:401'*) echo "FAIL: 401."; exit 1 ;;
        *) echo "FAIL: нет success."; exit 1 ;;
    esac
else
    echo "=== 2. Пропускаем retry — session-id не требовался ==="
fi
echo

# ---------- Шаг 3: torrent-add (paused) ----------
if [ -z "$MAGNET" ]; then
    echo "=== 3. Пропускаем torrent-add (magnet не задан) ==="
    echo "Чтобы проверить добавление, передай magnet 4-м параметром:"
    echo "  sh $0 $HOST '$USER_NAME' '***' '<своя_magnet_ссылка>'"
    echo
    echo "=== Спайк прошел до шага 3: RPC доступен, auth ок. ==="
    exit 0
fi

echo "=== 3. torrent-add (paused=true) ==="
echo "Magnet: $(printf '%s' "$MAGNET" | head -c 80)..."
ADD_OUT=$(curl -s -w '\nHTTP-STATUS:%{http_code}\n' -X POST "$RPC_URL" $AUTH_ARGS \
    -H 'Content-Type: application/json' \
    $SESS_HEADER_ARG \
    -d "{\"method\":\"torrent-add\",\"arguments\":{\"filename\":\"$MAGNET\",\"paused\":true}}")
echo "$ADD_OUT" | head -c 800
echo

case "$ADD_OUT" in
    *'"torrent-added"'*)
        echo "OK: торрент добавлен. Проверь Keenetic web-UI → Transmission, должна появиться запись."
        echo "Чтобы удалить: запусти transmission-remote или удали через web-UI."
        ;;
    *'"torrent-duplicate"'*)
        echo "OK: дубликат (уже был добавлен раньше). Это тоже валидный сценарий — плагин это обработает."
        ;;
    *)
        echo "FAIL: torrent-add не вернул success."
        exit 1
        ;;
esac

echo
echo "=== Спайк прошел: RPC доступен, auth ок, torrent-add работает. ==="
