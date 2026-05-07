#!/bin/sh
# Установка прокси для lampa-keenetic-dlna прямо на Кинетик через Entware.
# Ставит python3, cloudflared, наш serve.py, регистрирует init.d-сервис.
# После установки печатает публичный URL прокси — его надо вставить в
# Настройки LAMPA → Keenetic DLNA → Прокси URL.
#
# Запуск (на Кинетике с уже установленным Entware):
#   curl -sSL https://raw.githubusercontent.com/<user>/lampa-keenetic-dlna/main/scripts/entware-install.sh | sh
#
# Удаление:
#   /opt/etc/init.d/S99lampa-dlna stop
#   rm -rf /opt/lampa-keenetic-dlna /opt/etc/init.d/S99lampa-dlna

set -e

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/gudlayv/lampa-keenetic-dlna/main}"
INSTALL_DIR=/opt/lampa-keenetic-dlna
PORT="${PORT:-8780}"

echo "==> Проверка Entware"
if ! command -v opkg >/dev/null 2>&1; then
    echo "Entware не найден. Сначала установи Entware:"
    echo "https://help.keenetic.com/hc/ru/articles/360021214160"
    exit 1
fi

echo "==> opkg update"
opkg update

echo "==> Установка python3 и cloudflared"
opkg install python3 ca-certificates curl
# cloudflared в Entware есть как 'cloudflared' пакет на части архитектур.
# Если пакет не найден — качаем статичный бинарник под архитектуру.
if opkg list | grep -q '^cloudflared '; then
    opkg install cloudflared
else
    ARCH=$(uname -m)
    case "$ARCH" in
        aarch64)  CFD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
        armv7l)   CFD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
        x86_64)   CFD_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
        mips*)    echo "Архитектура $ARCH: cloudflared недоступен. Кинетик-MIPS не поддерживается."; exit 1 ;;
        *)        echo "Неизвестная архитектура: $ARCH"; exit 1 ;;
    esac
    echo "==> Качаю cloudflared под $ARCH из $CFD_URL"
    curl -sSL "$CFD_URL" -o /opt/bin/cloudflared
    chmod +x /opt/bin/cloudflared
fi

echo "==> Установка серверной части в $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/reports"
curl -sSL "$REPO_RAW/serve.py" -o "$INSTALL_DIR/serve.py"
chmod +x "$INSTALL_DIR/serve.py"

cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/sh
# Запускает serve.py + cloudflared quick tunnel, ловит публичный URL и
# сохраняет его в $INSTALL_DIR/tunnel.url для удобства.
cd "$INSTALL_DIR"
python3 serve.py $PORT > "$INSTALL_DIR/serve.log" 2>&1 &
SERVE_PID=\$!

cloudflared tunnel --url "http://localhost:$PORT" > "$INSTALL_DIR/cloudflared.log" 2>&1 &
CFD_PID=\$!

# Ждём пока cloudflared опубликует URL
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 1
    URL=\$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$INSTALL_DIR/cloudflared.log" | head -1)
    [ -n "\$URL" ] && break
done

if [ -n "\$URL" ]; then
    echo "\$URL" > "$INSTALL_DIR/tunnel.url"
    echo "\$URL/proxy/"
fi

trap "kill \$SERVE_PID \$CFD_PID 2>/dev/null" EXIT INT TERM
wait
EOF
chmod +x "$INSTALL_DIR/start.sh"

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
    nohup $INSTALL_DIR/start.sh > $INSTALL_DIR/run.log 2>&1 &
    echo "\$!" > /var/run/lampa-dlna.pid
}

stop() {
    pkill -f "python3 serve.py" 2>/dev/null
    pkill -f "cloudflared tunnel" 2>/dev/null
    rm -f /var/run/lampa-dlna.pid
}

status() {
    if pgrep -f "python3 serve.py" >/dev/null 2>&1; then
        echo "running"
        [ -f "$INSTALL_DIR/tunnel.url" ] && echo "tunnel: \$(cat $INSTALL_DIR/tunnel.url)/proxy/"
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
    echo "Готово! Прокси-URL:"
    echo ""
    echo "    ${URL}/proxy/"
    echo ""
    echo "Открой LAMPA → Настройки → Keenetic DLNA"
    echo "Вставь этот URL в поле «Прокси URL» (целиком, со /proxy/ в конце)."
else
    echo "Сервис запущен, но URL ещё не появился. Проверь:"
    echo "  /opt/etc/init.d/S99lampa-dlna status"
    echo "  cat $INSTALL_DIR/cloudflared.log"
fi
echo ""
echo "Внимание: trycloudflare quick tunnel меняет URL при каждом"
echo "перезапуске. После reboot Кинетика URL обновится — посмотри"
echo "/opt/etc/init.d/S99lampa-dlna status и обнови в LAMPA."
echo ""
echo "Для постоянного URL см. README → Cloudflare named tunnel."
echo "==========================================================="
