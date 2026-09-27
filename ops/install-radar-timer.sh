#!/usr/bin/env bash
# ops/install-radar-timer.sh — abilita il timer systemd user di Stavros Radar.
# Uso (dalla root del progetto): bash ops/install-radar-timer.sh
set -e

SYSTEMD_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

cp ops/radar.service "$SYSTEMD_DIR/radar.service"
cp ops/radar.timer "$SYSTEMD_DIR/radar.timer"

systemctl --user daemon-reload
systemctl --user enable --now radar.timer

echo "✔ Stavros Radar systemd user timer abilitato con successo!"
echo "Verifica con: systemctl --user list-timers radar.timer"