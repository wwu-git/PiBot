abi <abi/4.0>,
include <tunables/global>

# Chromium's process sandbox needs an unprivileged user namespace, which Ubuntu 24.04 and later
# deny to programs without a profile. Same model as Chrome's and VS Code's profiles: no extra
# confinement, only the userns permission, attached to the Electron binary the launcher executes.
profile ${executable} "/opt/${sanitizedProductName}/${executable}-bin" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}
