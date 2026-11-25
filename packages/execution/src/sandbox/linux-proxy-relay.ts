/**
 * Linux host side of the sandbox proxy handoff. Bubblewrap's trusted bootstrap creates both
 * listeners in its private network namespace. The host relays them to this run's SRT proxies.
 * It passes the workload's original stdin back over the same socket, then closes the handoff.
 */
export const linuxProxyRelay = `
import array
import os
import selectors
import signal
import socket
import subprocess
import sys
import threading

PORTS = (3128, 1080)
MAX_CONNECTIONS = 128

def validate_listener(fd, port):
    listener = socket.socket(fileno=fd)
    if (listener.family != socket.AF_INET or listener.type != socket.SOCK_STREAM
            or listener.getsockname() != ("127.0.0.1", port)
            or not listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN)):
        listener.close()
        raise ValueError("invalid proxy listener")
    return listener

def forward(source, destination):
    try:
        while chunk := source.recv(65536):
            destination.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def relay(downstream, upstream_port, slots):
    try:
        with downstream, socket.create_connection(("127.0.0.1", upstream_port), timeout=5) as upstream:
            upstream.settimeout(None)
            request = threading.Thread(target=forward, args=(downstream, upstream), daemon=True)
            request.start()
            forward(upstream, downstream)
            request.join()
    except OSError:
        pass
    finally:
        slots.release()

def copy_stdin(pipe):
    with os.fdopen(pipe, "wb", buffering=0) as destination:
        try:
            while data := os.read(0, 65536):
                remaining = memoryview(data)
                while remaining:
                    remaining = remaining[destination.write(remaining):]
        except BrokenPipeError:
            pass

def send_stdin(control):
    read_end, write_end = os.pipe()
    try:
        control.sendmsg([b"I"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [read_end]))])
        threading.Thread(target=copy_stdin, args=(write_end,), daemon=True).start()
    except BaseException:
        os.close(write_end)
        raise
    finally:
        os.close(read_end)

def serve(control, child, upstream_ports):
    with selectors.DefaultSelector() as selector:
        control.settimeout(5)
        marker, ancillary, flags, _ = control.recvmsg(1, socket.CMSG_SPACE(8), socket.MSG_CMSG_CLOEXEC)
        if marker != b"P" or flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or len(ancillary) != 1:
            raise ValueError("invalid proxy handoff")
        level, kind, data = ancillary[0]
        if (level, kind) != (socket.SOL_SOCKET, socket.SCM_RIGHTS) or len(data) != 8:
            raise ValueError("invalid proxy descriptors")
        fds = array.array("i", data)
        listeners = []
        try:
            for fd, port in zip(fds, PORTS):
                listeners.append(validate_listener(fd, port))
            for listener, upstream_port in zip(listeners, upstream_ports):
                selector.register(listener, selectors.EVENT_READ, upstream_port)
            send_stdin(control)
            control.close()
            slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
            while child.poll() is None:
                for key, _ in selector.select(0.25):
                    connection, _ = key.fileobj.accept()
                    if slots.acquire(blocking=False):
                        threading.Thread(target=relay, args=(connection, key.data, slots), daemon=True).start()
                    else:
                        connection.close()
        finally:
            for listener in listeners:
                listener.close()

def main():
    upstream_ports = tuple(map(int, sys.argv[1:3]))
    if len(upstream_ports) != 2 or any(not 0 < port <= 65535 for port in upstream_ports):
        raise ValueError("invalid upstream ports")
    control, sandbox = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    with control, sandbox, subprocess.Popen(sys.argv[3:], stdin=sandbox) as child:
        sandbox.close()
        def stop(_signum, _frame):
            child.terminate()
            raise SystemExit(125)
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(number, stop)
        try:
            serve(control, child, upstream_ports)
        finally:
            if child.poll() is None:
                child.kill()
        return child.returncode if child.returncode >= 0 else 128 - child.returncode

sys.exit(main())
`;
