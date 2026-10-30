#!/bin/sh
# Vicem — macOS / Linux 1-Click Setup Launcher
# Double-click this file in Finder / File Manager or run ./setup.command in your terminal.

cd "$(dirname "$0")" || exit 1
chmod +x ./vicem.mjs 2>/dev/null
node ./vicem.mjs setup || {
  echo "[ERR] Vicem setup failed. Check the error above and try again." >&2
  exit 1
}
echo ""
echo "================================================================"
echo "[OK] Vicem 1-Click Setup Complete!"
echo "     You can now run './vicem.mjs' or 'vicem' in any project."
echo "================================================================"
