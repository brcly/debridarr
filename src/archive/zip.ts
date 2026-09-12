import { crc32 } from 'node:zlib';
import { once } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import type { Writable } from 'node:stream';

// A minimal, streaming ZIP writer for one use case: a handful of large,
// already-compressed video files. STORE (method 0) avoids wasting CPU
// re-compressing video, and every entry always carries the ZIP64 extra
// fields (real debrid libraries routinely exceed the legacy 4 GiB per-file
// and per-archive limits) rather than conditionally switching formats per
// entry. CRC-32 cannot be known until a file is fully read, so it is
// deferred to a trailing data descriptor — each file is streamed exactly
// once, never buffered or read twice.
const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_FILE_HEADER_SIG = 0x02014b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const VERSION_ZIP64 = 45;
// bit 3 (data descriptor follows) | bit 11 (UTF-8 name).
const GENERAL_PURPOSE_FLAG = 0x0808;

function dosDateTime(when: Date): { time: number; date: number } {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = (Math.max(0, when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time, date };
}

interface ZipEntryRecord { nameBytes: Buffer; size: number; crc32: number; offset: number; time: number; date: number }

export interface ZipFileEntry {
  // Forward-slash path inside the archive. Callers are responsible for
  // sanitizing it (no leading slash, no `.`/`..` segments) before this class
  // ever sees it — this writer trusts the name as given.
  name: string;
  size: number;
  open: () => Promise<FileHandle>;
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: ZipEntryRecord[] = [];
  private readonly out: Writable;
  private readonly signal: AbortSignal;

  constructor(out: Writable, signal: AbortSignal) {
    this.out = out;
    this.signal = signal;
  }

  private async push(buffer: Buffer): Promise<void> {
    this.signal.throwIfAborted();
    if (buffer.length && !this.out.write(buffer)) await once(this.out, 'drain', { signal: this.signal });
    this.offset += buffer.length;
  }

  async addFile(entry: ZipFileEntry): Promise<void> {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(new Date());
    const localOffset = this.offset;

    // Sizes are known upfront (STORE: compressed == uncompressed); only the
    // CRC-32 is deferred, via the sentinel + data-descriptor mechanism.
    const localExtra = Buffer.alloc(20);
    localExtra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(BigInt(entry.size), 4);
    localExtra.writeBigUInt64LE(BigInt(entry.size), 12);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION_ZIP64, 4);
    header.writeUInt16LE(GENERAL_PURPOSE_FLAG, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // crc-32 deferred
    header.writeUInt32LE(0xffffffff, 18); // compressed size: see zip64 extra
    header.writeUInt32LE(0xffffffff, 22); // uncompressed size: see zip64 extra
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(localExtra.length, 28);

    await this.push(header);
    await this.push(nameBytes);
    await this.push(localExtra);

    const handle = await entry.open();
    let crc = 0;
    let streamed = 0;
    try {
      const readable = handle.createReadStream({ start: 0, end: entry.size - 1, autoClose: false });
      try {
        for await (const chunk of readable) {
          const buf = chunk as Buffer;
          crc = crc32(buf, crc) >>> 0;
          streamed += buf.length;
          await this.push(buf);
        }
      } finally { readable.destroy(); }
    } finally { await handle.close(); }
    if (streamed !== entry.size) throw new Error(`${entry.name} changed size while zipping (expected ${entry.size}, read ${streamed})`);

    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIG, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeBigUInt64LE(BigInt(entry.size), 8);
    descriptor.writeBigUInt64LE(BigInt(entry.size), 16);
    await this.push(descriptor);

    this.entries.push({ nameBytes, size: entry.size, crc32: crc, offset: localOffset, time, date });
  }

  // Central directory, ZIP64 end-of-central-directory record + locator, then
  // the legacy end-of-central-directory record (sentinel values throughout —
  // every zip64-aware reader follows the locator instead).
  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const entry of this.entries) {
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(entry.size), 4);
      extra.writeBigUInt64LE(BigInt(entry.size), 12);
      extra.writeBigUInt64LE(BigInt(entry.offset), 20);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_FILE_HEADER_SIG, 0);
      header.writeUInt16LE(VERSION_ZIP64, 4); // version made by
      header.writeUInt16LE(VERSION_ZIP64, 6); // version needed
      header.writeUInt16LE(GENERAL_PURPOSE_FLAG, 8);
      header.writeUInt16LE(0, 10); // stored
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(0xffffffff, 20);
      header.writeUInt32LE(0xffffffff, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt16LE(0, 32); // comment length
      header.writeUInt16LE(0, 34); // disk number start
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(0, 38); // external attributes
      header.writeUInt32LE(0xffffffff, 42); // local header offset: see zip64 extra

      await this.push(header);
      await this.push(entry.nameBytes);
      await this.push(extra);
    }
    const cdSize = this.offset - cdStart;
    const zip64EocdOffset = this.offset;

    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    zip64Eocd.writeBigUInt64LE(44n, 4); // record size, excluding this field and the signature
    zip64Eocd.writeUInt16LE(VERSION_ZIP64, 12);
    zip64Eocd.writeUInt16LE(VERSION_ZIP64, 14);
    zip64Eocd.writeUInt32LE(0, 16); // this disk
    zip64Eocd.writeUInt32LE(0, 20); // disk with central directory start
    zip64Eocd.writeBigUInt64LE(BigInt(this.entries.length), 24);
    zip64Eocd.writeBigUInt64LE(BigInt(this.entries.length), 32);
    zip64Eocd.writeBigUInt64LE(BigInt(cdSize), 40);
    zip64Eocd.writeBigUInt64LE(BigInt(cdStart), 48);
    await this.push(zip64Eocd);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
    locator.writeUInt32LE(1, 16); // total disks
    await this.push(locator);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    eocd.writeUInt16LE(0, 20);
    await this.push(eocd);
  }
}
