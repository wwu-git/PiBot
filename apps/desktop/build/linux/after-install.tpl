#!/bin/sh
# postinst of the Pi Bot desktop .deb (electron-builder fills in the names). POSIX sh only.
# Never fails the installation over AppArmor: without it there is no restriction to lift.
set -e

APP_DIR='/opt/${sanitizedProductName}'
EXECUTABLE='${executable}'
PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"

if command -v update-alternatives >/dev/null 2>&1; then
  # A plain link left by an older install is replaced by the managed alternative.
  if [ -L "/usr/bin/$EXECUTABLE" ] && [ "$(readlink "/usr/bin/$EXECUTABLE")" != "/etc/alternatives/$EXECUTABLE" ]; then
    rm -f "/usr/bin/$EXECUTABLE"
  fi
  update-alternatives --install "/usr/bin/$EXECUTABLE" "$EXECUTABLE" "$APP_DIR/$EXECUTABLE" 100 ||
    ln -sf "$APP_DIR/$EXECUTABLE" "/usr/bin/$EXECUTABLE"
else
  ln -sf "$APP_DIR/$EXECUTABLE" "/usr/bin/$EXECUTABLE"
fi

# The launcher always passes --disable-setuid-sandbox, so the setuid helper is never used and
# must not become a root-owned setuid binary.
if [ -e "$APP_DIR/chrome-sandbox" ]; then
  chmod 0755 "$APP_DIR/chrome-sandbox"
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime || true
fi
# Registers the pibot:// handler from the desktop entry.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications || true
fi

apparmor_enabled() {
  [ -r /sys/module/apparmor/parameters/enabled ] &&
    [ "$(cat /sys/module/apparmor/parameters/enabled)" = "Y" ]
}

in_chroot() {
  [ -x /usr/bin/ischroot ] && /usr/bin/ischroot
}

# Only kernels with Ubuntu's restriction need the profile, but it is installed wherever this
# AppArmor understands it, so enabling AppArmor or the restriction later keeps Pi Bot working.
# An older parser without abi 4.0 (Ubuntu 22.04) has no such restriction: skip quietly.
if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1 && [ -r "$PROFILE_SOURCE" ]; then
  if apparmor_parser --skip-kernel-load --skip-cache --quiet "$PROFILE_SOURCE" >/dev/null 2>&1; then
    if cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET" && chmod 0644 "$PROFILE_TARGET"; then
      if apparmor_enabled && ! in_chroot &&
        ! apparmor_parser --replace --skip-read-cache "$PROFILE_TARGET"; then
        echo "Pi Bot: could not load $PROFILE_TARGET; it loads at the next boot, or run: sudo apparmor_parser -r $PROFILE_TARGET" >&2
      fi
    else
      echo "Pi Bot: could not write $PROFILE_TARGET; Pi Bot may not start while unprivileged user namespaces are restricted." >&2
    fi
  else
    echo "Pi Bot: this AppArmor version does not support the bundled profile; skipped." >&2
  fi
fi

exit 0
