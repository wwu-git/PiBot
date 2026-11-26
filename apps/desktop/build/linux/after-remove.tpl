#!/bin/sh
# postrm of the Pi Bot desktop .deb (electron-builder fills in the names). POSIX sh only.
# On upgrade the new postinst replaces the link and the profile, so only remove and purge clean up.
set -e

APP_DIR='/opt/${sanitizedProductName}'
EXECUTABLE='${executable}'
PROFILE_TARGET="/etc/apparmor.d/$EXECUTABLE"

case "$1" in
  remove | purge)
    if command -v update-alternatives >/dev/null 2>&1; then
      update-alternatives --remove "$EXECUTABLE" "$APP_DIR/$EXECUTABLE" || true
    fi
    if [ -L "/usr/bin/$EXECUTABLE" ] && [ ! -e "/usr/bin/$EXECUTABLE" ]; then
      rm -f "/usr/bin/$EXECUTABLE"
    fi
    # postinst wrote this file, so it is not a conffile dpkg would keep or remove. It only
    # names the binary that was just removed: unload it, then delete it.
    if [ -f "$PROFILE_TARGET" ]; then
      if [ -r /sys/module/apparmor/parameters/enabled ] &&
        [ "$(cat /sys/module/apparmor/parameters/enabled)" = "Y" ] &&
        ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; } &&
        command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser --remove "$PROFILE_TARGET" >/dev/null 2>&1 || true
      fi
      rm -f "$PROFILE_TARGET"
    fi
    if [ "$1" = purge ]; then
      for cached in /var/cache/apparmor/*/"$EXECUTABLE" /etc/apparmor.d/cache/"$EXECUTABLE"; do
        if [ -f "$cached" ]; then rm -f "$cached"; fi
      done
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database /usr/share/applications || true
    fi
    ;;
esac

exit 0
