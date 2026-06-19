#!/usr/bin/env bash
# Uninstalls Spomienka from a Raspberry Pi.
# Removes systemd services, installed binaries, config, data, and the cloned repo.
set -e

echo "This will completely remove Spomienka from this system:"
echo "  - Systemd services: frame-viewer, pocketbase, frame-admin"
echo "  - Installed files in /opt/pocketbase, /var/lib/pocketbase,"
echo "    /etc/frame-viewer, /var/cache/frame-viewer, /usr/local/bin/frame-viewer"
echo "  - ~/spomienka and any ~/spomienka.backup.* directories"
echo ""
read -r -p "Are you sure? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo "Stopping and disabling services..."
sudo systemctl stop frame-viewer pocketbase frame-admin 2>/dev/null || true
sudo systemctl disable frame-viewer pocketbase frame-admin 2>/dev/null || true

echo "Removing service unit files..."
sudo rm -f /etc/systemd/system/frame-viewer.service \
           /etc/systemd/system/pocketbase.service \
           /etc/systemd/system/frame-admin.service
sudo systemctl daemon-reload

echo "Removing installed files..."
sudo rm -rf /opt/pocketbase /var/lib/pocketbase /etc/frame-viewer /var/cache/frame-viewer
sudo rm -f /usr/local/bin/frame-viewer

echo "Removing repository and backups..."
rm -rf ~/spomienka ~/spomienka-install-summary.txt
rm -rf ~/spomienka.backup.* 2>/dev/null || true

echo "Uninstall complete."
