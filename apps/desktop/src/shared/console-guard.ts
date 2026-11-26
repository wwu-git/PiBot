/**
 * Console output is best effort. When the app was started from a terminal or script that has
 * since exited, the pipe behind stdout/stderr is closed and the next console write emits EPIPE
 * (or ERR_STREAM_DESTROYED) as an 'error' event. With no listener Node turns it into an uncaught
 * exception, which Electron shows as a native crash dialog in the main process. Ignoring it is
 * safe: every line also goes to the file log, and a closed pipe has nobody left to read it.
 */
export function guardConsoleStreams(streams: readonly (NodeJS.WriteStream | undefined)[]) {
  for (const stream of streams) {
    if (!stream || stream.listenerCount("error") > 0) continue;
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") return;
      // Any other console failure is equally unreadable by anyone; the file logger has the
      // line, and a console problem must never take the app down.
    });
  }
}
