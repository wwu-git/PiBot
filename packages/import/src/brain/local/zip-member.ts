// Streams one allowlisted Takeout member through the policy-bound file handle.
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { ImportFailure, type ImportFile } from "../adapter.ts";

const TAIL_BYTES = 65_557;
const CHUNK = 64 * 1024;
const MAX_MEMBER = 512 * 1024 * 1024;
const MAX_DIRECTORY = 16 * 1024 * 1024;

type Member = {
  method: number;
  flags: number;
  length: number;
  packed: number;
  crc: number;
  header: number;
};

async function directory(reader: ImportFile) {
  const start = Math.max(0, reader.size - TAIL_BYTES);
  const first = Math.min(reader.size - start, CHUNK);
  const tail = Buffer.concat([
    await reader.read(start, first),
    await reader.read(start + first, reader.size - start - first),
  ]);
  for (let end = tail.length - 22; end >= 0; end--) {
    if (tail.readUInt32LE(end) !== 0x06054b50) continue;
    if (end + 22 + tail.readUInt16LE(end + 20) !== tail.length) continue;
    const count = tail.readUInt16LE(end + 10);
    const bytes = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (
      tail.readUInt32LE(end + 4) !== 0 ||
      tail.readUInt16LE(end + 8) !== count ||
      count === 0xffff ||
      bytes > MAX_DIRECTORY ||
      offset + bytes !== start + end
    )
      throw new ImportFailure("unsupported");
    return { count, offset, limit: offset + bytes };
  }
  throw new ImportFailure("format");
}

async function findMember(reader: ImportFile, name: Buffer) {
  const index = await directory(reader);
  let offset = index.offset;
  let match: Member | undefined;
  for (let n = 0; n < index.count; n++) {
    if (offset + 46 > index.limit) throw new ImportFailure("format");
    const header = await reader.read(offset, 46);
    if (header.readUInt32LE(0) !== 0x02014b50) throw new ImportFailure("format");
    const nameLength = header.readUInt16LE(28);
    const nameOffset = offset + 46;
    offset = nameOffset + nameLength + header.readUInt16LE(30) + header.readUInt16LE(32);
    if (offset > index.limit) throw new ImportFailure("format");
    if (nameLength !== name.length || !(await reader.read(nameOffset, nameLength)).equals(name))
      continue;
    if (match || header.readUInt16LE(34) !== 0) throw new ImportFailure("format");
    const mode = (header.readUInt32LE(38) >>> 16) & 0o170000;
    if (header[5] === 3 && mode && mode !== 0o100000) throw new ImportFailure("format");
    match = {
      flags: header.readUInt16LE(8),
      method: header.readUInt16LE(10),
      crc: header.readUInt32LE(16),
      packed: header.readUInt32LE(20),
      length: header.readUInt32LE(24),
      header: header.readUInt32LE(42),
    };
  }
  if (!match || offset !== index.limit) throw new ImportFailure("format");
  return { match, dataEnd: index.offset };
}

async function dataOffset(reader: ImportFile, member: Member, name: Buffer, end: number) {
  const { header, flags, method, crc, packed, length } = member;
  if (flags & ~0x080e || (method !== 0 && method !== 8)) throw new ImportFailure("unsupported");
  if (length > MAX_MEMBER || length > Math.max(1024 * 1024, packed * 300))
    throw new ImportFailure("limit");
  if (header + 30 + name.length > end) throw new ImportFailure("format");
  const local = await reader.read(header, 30);
  const offset = header + 30 + name.length + local.readUInt16LE(28);
  if (
    local.readUInt32LE(0) !== 0x04034b50 ||
    local.readUInt16LE(6) !== flags ||
    local.readUInt16LE(8) !== method ||
    local.readUInt16LE(26) !== name.length ||
    (!(flags & 8) &&
      (local.readUInt32LE(14) !== crc ||
        local.readUInt32LE(18) !== packed ||
        local.readUInt32LE(22) !== length)) ||
    offset + packed > end ||
    !(await reader.read(header + 30, name.length)).equals(name)
  )
    throw new ImportFailure("format");
  return offset;
}

async function* packedChunks(reader: ImportFile, offset: number, packed: number) {
  for (let read = 0; read < packed; read += CHUNK)
    yield await reader.read(offset + read, Math.min(CHUNK, packed - read));
}

export async function* zipMember(reader: ImportFile, path: string, signal: AbortSignal) {
  const name = Buffer.from(path);
  const { match, dataEnd } = await findMember(reader, name);
  const offset = await dataOffset(reader, match, name, dataEnd);
  const input = Readable.from(packedChunks(reader, offset, match.packed), {
    objectMode: false,
    signal,
  });
  const output = match.method === 8 ? input.compose(createInflateRaw(), { signal }) : input;
  let size = 0;
  let checksum = 0;
  try {
    for await (const chunk of output) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) throw new ImportFailure("format");
      size += chunk.length;
      if (size > match.length) throw new ImportFailure("format");
      checksum = crc32(chunk, checksum);
      yield chunk;
    }
    if (size !== match.length || checksum !== match.crc) throw new ImportFailure("format");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportFailure) throw error;
    // zlib errors may carry library details; the caller only receives a format code.
    if (error instanceof Error && "code" in error && String(error.code).startsWith("Z_"))
      throw new ImportFailure("format");
    throw error;
  } finally {
    output.destroy();
    input.destroy();
    // The iterator reports any read failure; drain here before the owner closes its handle.
    await finished(input, { cleanup: true }).catch(() => undefined);
  }
}
