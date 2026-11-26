// Read only selected ZIP members through the authorized file descriptor, without extracting files.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { ImportFailure, type ImportFile } from "../adapter.ts";

const CHUNK = 64 * 1024;
const MAX_INFLATED = 768 * 1024 * 1024;
const MAX_DIRECTORY = 16 * 1024 * 1024;

export interface ZipMember {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  checksum: number;
  compressed: number;
  size: number;
  offset: number;
  directoryOffset: number;
  symlink: boolean;
}

function invalid(): never {
  throw new ImportFailure("format");
}

async function directoryInfo(file: ImportFile) {
  const start = Math.max(0, file.size - 65_557);
  const tail = await file.read(start, file.size - start);
  for (let end = tail.length - 22; end >= 0; end--) {
    if (
      tail.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + tail.readUInt16LE(end + 20) !== tail.length
    )
      continue;
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (
      tail.readUInt32LE(end + 4) ||
      count === 0xffff ||
      tail.readUInt16LE(end + 8) !== count ||
      offset + length !== start + end
    )
      invalid();
    if (length > MAX_DIRECTORY) throw new ImportFailure("limit");
    return { count, offset, length };
  }
  return invalid();
}

export async function zipDirectory(file: ImportFile, signal: AbortSignal) {
  const directory = await directoryInfo(file);
  const bytes = await file.read(directory.offset, directory.length);
  const members = new Map<string, ZipMember>();
  let cursor = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < directory.count; index++) {
    signal.throwIfAborted();
    if (index % 256 === 255) await yieldToLoop(undefined, { signal });
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const nameEnd = cursor + 46 + bytes.readUInt16LE(cursor + 28);
    const next = nameEnd + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > bytes.length || nameEnd === cursor + 46 || bytes.readUInt16LE(cursor + 34))
      invalid();
    const nameBytes = bytes.subarray(cursor + 46, nameEnd);
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      invalid();
    }
    if (/^[/]|[\\:\0]|(?:^|\/)\.\.?($|\/)|\/\//.test(name) || members.has(name)) invalid();
    members.set(name, {
      name,
      nameBytes,
      flags: bytes.readUInt16LE(cursor + 8),
      method: bytes.readUInt16LE(cursor + 10),
      checksum: bytes.readUInt32LE(cursor + 16),
      compressed: bytes.readUInt32LE(cursor + 20),
      size: bytes.readUInt32LE(cursor + 24),
      offset: bytes.readUInt32LE(cursor + 42),
      directoryOffset: directory.offset,
      symlink: (bytes.readUInt16LE(cursor + 40) & 0xf000) === 0xa000,
    });
    cursor = next;
  }
  if (cursor !== bytes.length) invalid();
  return members;
}

async function memberOffset(file: ImportFile, entry: ZipMember) {
  if (entry.symlink || entry.flags & ~0x80e || (entry.method !== 0 && entry.method !== 8))
    invalid();
  if (entry.size > MAX_INFLATED) throw new ImportFailure("limit");
  if (entry.offset + 30 > entry.directoryOffset) invalid();
  const header = await file.read(entry.offset, 30);
  const nameLength = header.readUInt16LE(26);
  const offset = entry.offset + 30 + nameLength + header.readUInt16LE(28);
  if (
    header.readUInt32LE(0) !== 0x04034b50 ||
    header.readUInt16LE(6) !== entry.flags ||
    header.readUInt16LE(8) !== entry.method ||
    offset + entry.compressed > entry.directoryOffset ||
    nameLength !== entry.nameBytes.length ||
    (entry.method === 0 && entry.compressed !== entry.size)
  )
    invalid();
  if (
    !(entry.flags & 8) &&
    (header.readUInt32LE(14) !== entry.checksum ||
      header.readUInt32LE(18) !== entry.compressed ||
      header.readUInt32LE(22) !== entry.size)
  )
    invalid();
  if (!(await file.read(entry.offset + 30, nameLength)).equals(entry.nameBytes)) invalid();
  return offset;
}

async function* compressed(file: ImportFile, offset: number, length: number) {
  for (let read = 0; read < length; read += CHUNK) {
    yield await file.read(offset + read, Math.min(CHUNK, length - read));
  }
}

async function* inflate(
  input: AsyncIterable<Buffer>,
  signal: AbortSignal,
  compressedLength: number,
): AsyncGenerator<Buffer> {
  const source = Readable.from(input);
  const stream = createInflateRaw();
  const done = pipeline(source, stream, { signal });
  // Await the original promise below after reading, including errors from the authorized input.
  void done.catch(() => undefined);
  try {
    for await (const chunk of stream) yield chunk as Buffer;
    await done;
    if (stream.bytesWritten !== compressedLength) invalid();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    invalid();
  } finally {
    source.destroy();
    stream.destroy();
    await done.catch(() => undefined);
  }
}

export async function* zipMember(file: ImportFile, entry: ZipMember, signal: AbortSignal) {
  const offset = await memberOffset(file, entry);
  const raw = compressed(file, offset, entry.compressed);
  const input = entry.method === 0 ? raw : inflate(raw, signal, entry.compressed);
  let count = 0;
  let checksum = 0;
  for await (const chunk of input) {
    signal.throwIfAborted();
    count += chunk.length;
    if (count > entry.size) invalid();
    checksum = crc32(chunk, checksum);
    yield chunk;
  }
  if (count !== entry.size || checksum !== entry.checksum) invalid();
}
