// Run by Bubblewrap with a single inherited handoff socket on stdin. No workload code runs
// until both listeners and the handoff are closed and the syscall filter is active.
export const linuxProxyBootstrap = `
import array
import ctypes
import errno
import os
import socket
import stat
import sys

PORTS = (3128, 1080)
ALLOW = 0x7fff0000
ERRNO = 0x00050000
MASKED_EQ = 7
EQ = 4

class Comparison(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]

def install_filter():
    try:
        seccomp = ctypes.CDLL("libseccomp.so.2")
    except OSError as error:
        raise RuntimeError("libseccomp.so.2 required for sandbox proxy") from error
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add_exact_array.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
        ctypes.POINTER(Comparison),
    ]
    context = seccomp.seccomp_init(ALLOW)
    if not context:
        raise RuntimeError("seccomp_init failed")

    def deny(name, error=errno.EPERM, comparison=None, fallback=None):
        number = seccomp.seccomp_syscall_resolve_name(name.encode("ascii"))
        if number < 0 and fallback is not None:
            number = fallback
        if number < 0 or seccomp.seccomp_rule_add_exact_array(
                context, ERRNO | error, number, int(comparison is not None), comparison):
            raise RuntimeError("seccomp rule unavailable: " + name)

    try:
        for family in (socket.AF_UNIX, socket.AF_VSOCK):
            deny("socket", comparison=Comparison(0, EQ, family, 0))
        for name in ("io_uring_setup", "io_uring_enter", "io_uring_register", "setns",
                     "mount", "umount2", "pivot_root", "open_tree", "move_mount",
                     "fsopen", "fsconfig", "fsmount", "fspick"):
            deny(name)
        deny("mount_setattr", fallback=442)
        deny("open_tree_attr", fallback=467)
        deny("clone3", errno.ENOSYS)
        for name, flags in (("clone", (0x10000000, 0x20000)),
                            ("unshare", (0x10000000, 0x20000, 0x100000))):
            for flag in flags:
                deny(name, comparison=Comparison(0, MASKED_EQ, flag, flag))
        if seccomp.seccomp_load(context):
            raise RuntimeError("seccomp_load failed")
    finally:
        seccomp.seccomp_release(context)

def main():
    if os.uname().machine not in ("x86_64", "aarch64"):
        raise RuntimeError("unsupported sandbox architecture")
    listeners = []
    try:
        for port in PORTS:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listeners.append(listener)
            listener.bind(("127.0.0.1", port))
            listener.listen(128)
        with socket.socket(fileno=0) as control:
            fds = array.array("i", [listener.fileno() for listener in listeners])
            control.sendmsg([b"P"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, fds)])
            control.settimeout(5)
            marker, ancillary, flags, _ = control.recvmsg(
                1, socket.CMSG_SPACE(4), socket.MSG_CMSG_CLOEXEC)
        if marker != b"I" or flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or len(ancillary) != 1:
            raise ValueError("invalid stdin handoff")
        level, kind, data = ancillary[0]
        if (level, kind) != (socket.SOL_SOCKET, socket.SCM_RIGHTS) or len(data) != 4:
            raise ValueError("invalid stdin descriptor")
        fd = array.array("i", data)[0]
        try:
            if not stat.S_ISFIFO(os.fstat(fd).st_mode):
                raise ValueError("workload stdin must be a pipe")
            os.dup2(fd, 0)
        finally:
            os.close(fd)
    finally:
        for listener in listeners:
            listener.close()
    install_filter()
    os.execv(sys.argv[1], sys.argv[1:])

main()
`;
