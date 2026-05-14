#!/bin/sh
# Установка прокси для lampa-keenetic-dlna на Кинетик через Entware.
#
# По умолчанию ставит ТОЛЬКО локальный HTTP-прокси на порту 8780.
# Прокси URL для LAMPA: http://<keenetic-ip>:8780/proxy/
# Никаких внешних сервисов, всё внутри LAN.
#
# Если LAMPA на твоей платформе блокирует HTTP к LAN-IP (Mixed Content,
# Private Network Access) — добавь флаг --tunnel, поднимется cloudflared
# с публичным HTTPS-URL.
#
# Запуск (на Кинетике с уже установленным Entware):
#   curl -sSL https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main/scripts/entware-install.sh | sh
#
# С туннелем:
#   curl -sSL https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main/scripts/entware-install.sh | sh -s -- --tunnel
#
# Удаление:
#   /opt/etc/init.d/S99lampa-dlna stop
#   rm -rf /opt/lampa-keenetic-dlna /opt/etc/init.d/S99lampa-dlna

set -e

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main}"
INSTALL_DIR=/opt/lampa-keenetic-dlna
PORT="${PORT:-8780}"
DLNA_PROXY_ALLOW="${DLNA_PROXY_ALLOW:-192.168.1.1:8200,192.168.1.1:8090}"

USE_TUNNEL=0
for arg in "$@"; do
    case "$arg" in
        --tunnel) USE_TUNNEL=1 ;;
    esac
done

echo "==> Проверка Entware"
if ! command -v opkg >/dev/null 2>&1; then
    echo "Entware не найден. Сначала установи Entware:"
    echo "https://help.keenetic.com/hc/ru/articles/360021214160"
    exit 1
fi

echo "==> opkg update"
opkg update

echo "==> Установка python3, ca-certificates, curl"
opkg install python3 ca-certificates curl

if [ "$USE_TUNNEL" = 1 ]; then
    echo "==> Установка cloudflared (для публичного HTTPS-URL)"
    if opkg list | grep -q '^cloudflared '; then
        opkg install cloudflared
    else
        ARCH=$(uname -m)
        case "$ARCH" in
            aarch64)  CFD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
            armv7l)   CFD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
            x86_64)   CFD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
            mips*)    echo "Архитектура $ARCH: cloudflared недоступен."; exit 1 ;;
            *)        echo "Неизвестная архитектура: $ARCH"; exit 1 ;;
        esac
        echo "==> Качаю cloudflared под $ARCH из $CFD_URL"
        curl -sSL "$CFD_URL" -o /opt/bin/cloudflared
        chmod +x /opt/bin/cloudflared
    fi
fi

echo "==> Установка прокси в $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
curl -sSL "$REPO_RAW/serve.py" -o "$INSTALL_DIR/serve.py"
chmod +x "$INSTALL_DIR/serve.py"

if [ "$USE_TUNNEL" = 1 ]; then
    cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/sh
# Запускает serve.py + cloudflared quick tunnel.
cd "$INSTALL_DIR"
DLNA_PROXY_PORT=$PORT DLNA_PROXY_ALLOW="$DLNA_PROXY_ALLOW" \\
    python3 serve.py > "$INSTALL_DIR/serve.log" 2>&1 &
SERVE_PID=\$!

cloudflared tunnel --url "http://localhost:$PORT" > "$INSTALL_DIR/cloudflared.log" 2>&1 &
CFD_PID=\$!

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 1
    URL=\$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$INSTALL_DIR/cloudflared.log" | head -1)
    [ -n "\$URL" ] && break
done

if [ -n "\$URL" ]; then
    echo "\$URL" > "$INSTALL_DIR/tunnel.url"
fi

trap "kill \$SERVE_PID \$CFD_PID 2>/dev/null" EXIT INT TERM
wait
EOF
else
    cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/sh
# Запускает только serve.py — локальный HTTP-прокси на $PORT.
cd "$INSTALL_DIR"
exec python3 serve.py 2>&1 > "$INSTALL_DIR/serve.log"
EOF
fi
chmod +x "$INSTALL_DIR/start.sh"

# Заполняем env-параметры через wrapper
cat > "$INSTALL_DIR/env" <<EOF
DLNA_PROXY_PORT=$PORT
DLNA_PROXY_ALLOW=$DLNA_PROXY_ALLOW
EOF

echo "==> init.d-сервис /opt/etc/init.d/S99lampa-dlna"
cat > /opt/etc/init.d/S99lampa-dlna <<EOF
#!/bin/sh
ENABLED=yes
PROCS=lampa-dlna
ARGS=""
PREARGS=""
DESC=\$PROCS
PATH=/opt/sbin:/opt/bin:/sbin:/bin:/usr/sbin:/usr/bin

start() {
    . $INSTALL_DIR/env
    export DLNA_PROXY_PORT DLNA_PROXY_ALLOW
    nohup $INSTALL_DIR/start.sh > $INSTALL_DIR/run.log 2>&1 &
    echo "\$!" > /var/run/lampa-dlna.pid
}

stop() {
    pkill -f "python3 .*serve.py" 2>/dev/null
    pkill -f "cloudflared tunnel" 2>/dev/null
    rm -f /var/run/lampa-dlna.pid
}

status() {
    if pgrep -f "python3 .*serve.py" >/dev/null 2>&1; then
        echo "running"
        if [ -f "$INSTALL_DIR/tunnel.url" ]; then
            echo "tunnel: \$(cat $INSTALL_DIR/tunnel.url)/proxy/"
        else
            KEENETIC_IP=\$(ip route get 1.1.1.1 2>/dev/null | awk '{print \$7; exit}')
            [ -z "\$KEENETIC_IP" ] && KEENETIC_IP="<keenetic-ip>"
            echo "local:  http://\$KEENETIC_IP:$PORT/proxy/"
        fi
    else
        echo "stopped"
    fi
}

case "\$1" in
    start)   start ;;
    stop)    stop  ;;
    restart) stop; sleep 1; start ;;
    status)  status ;;
    *) echo "Usage: \$0 {start|stop|restart|status}"; exit 1 ;;
esac
EOF
chmod +x /opt/etc/init.d/S99lampa-dlna

echo "==> Запускаю сервис"
/opt/etc/init.d/S99lampa-dlna start

if [ "$USE_TUNNEL" = 1 ]; then
    echo "==> Жду публичный URL (до 30 сек)…"
    URL=""
    for i in $(seq 1 30); do
        sleep 1
        if [ -f "$INSTALL_DIR/tunnel.url" ]; then
            URL=$(cat "$INSTALL_DIR/tunnel.url")
            [ -n "$URL" ] && break
        fi
    done

    echo ""
    echo "==========================================================="
    if [ -n "$URL" ]; then
        echo "Прокси-URL для LAMPA:"
        echo ""
        echo "    ${URL}/proxy/"
    else
        echo "Сервис запущен, но URL ещё не появился. Проверь:"
        echo "  /opt/etc/init.d/S99lampa-dlna status"
        echo "  cat $INSTALL_DIR/cloudflared.log"
    fi
    echo ""
    echo "Внимание: trycloudflare quick tunnel меняет URL при каждом"
    echo "перезапуске. После reboot Кинетика URL обновится — посмотри"
    echo "/opt/etc/init.d/S99lampa-dlna status и обнови в LAMPA."
    echo "==========================================================="
else
    KEENETIC_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
    [ -z "$KEENETIC_IP" ] && KEENETIC_IP="<keenetic-ip>"
    sleep 1
    echo ""
    echo "==========================================================="
    echo "Прокси-URL для LAMPA:"
    echo ""
    echo "    http://${KEENETIC_IP}:${PORT}/proxy/"
    echo ""
    echo "Открой LAMPA → Настройки → Keenetic DLNA"
    echo "Вставь этот URL в поле «Прокси URL»."
    echo ""
    echo "Если LAMPA пишет «Прокси не настроен» / Browse падает —"
    echo "значит платформа блокирует HTTP к LAN. Перезапусти с туннелем:"
    echo ""
    echo "    /opt/etc/init.d/S99lampa-dlna stop"
    echo "    sh $0 --tunnel"
    echo "==========================================================="
fi
