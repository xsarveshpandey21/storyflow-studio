/**
 * Pure JavaScript ZIP archive generator (PKZip standard, STORE / uncompressed).
 * Zero external dependencies. Works in modern browsers (Blob) and Node.js (Uint8Array / Buffer).
 */

// Precomputed CRC32 table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(uint8Array) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = CRC_TABLE[(crc ^ uint8Array[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class SimpleZip {
  constructor() {
    this.files = []; // Array<{ name: string, data: Uint8Array, date: Date }>
  }

  /**
   * Adds a file to the zip.
   * @param {string} filename 
   * @param {Uint8Array|ArrayBuffer|Blob|string} content 
   * @param {Date} [date]
   */
  async addFile(filename, content, date = new Date()) {
    let data;
    if (typeof content === 'string') {
      data = new TextEncoder().encode(content);
    } else if (content instanceof Uint8Array) {
      data = content;
    } else if (content instanceof ArrayBuffer) {
      data = new Uint8Array(content);
    } else if (typeof Blob !== 'undefined' && content instanceof Blob) {
      const buf = await content.arrayBuffer();
      data = new Uint8Array(buf);
    } else {
      throw new Error(`Unsupported content type for ${filename}`);
    }

    this.files.push({
      name: filename.replace(/\\/g, '/'),
      data,
      date
    });
  }

  /**
   * Builds the ZIP archive and returns it as a Uint8Array.
   * @returns {Uint8Array}
   */
  generateUint8Array() {
    const encoder = new TextEncoder();
    const localHeaders = [];
    const centralDirs = [];
    let offset = 0;

    for (const file of this.files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = file.data;
      const fileCrc = crc32(dataBytes);
      const size = dataBytes.length;

      // Convert Date to MS-DOS time and date
      const d = file.date;
      const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
      const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

      // Local File Header (30 bytes + name length)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lhView = new DataView(localHeader.buffer);
      lhView.setUint32(0, 0x04034b50, true); // Local file header signature
      lhView.setUint16(4, 20, true);         // Version needed: 2.0
      lhView.setUint16(6, 0x0800, true);     // Flags: bit 11 = UTF-8 filename
      lhView.setUint16(8, 0, true);          // Compression: 0 = STORE
      lhView.setUint16(10, dosTime, true);
      lhView.setUint16(12, dosDate, true);
      lhView.setUint32(14, fileCrc, true);
      lhView.setUint32(18, size, true);      // Compressed size
      lhView.setUint32(22, size, true);      // Uncompressed size
      lhView.setUint16(26, nameBytes.length, true);
      lhView.setUint16(28, 0, true);         // Extra field length
      localHeader.set(nameBytes, 30);

      const localOffset = offset;
      localHeaders.push({ header: localHeader, data: dataBytes });
      offset += localHeader.length + dataBytes.length;

      // Central Directory Header (46 bytes + name length)
      const cdHeader = new Uint8Array(46 + nameBytes.length);
      const cdView = new DataView(cdHeader.buffer);
      cdView.setUint32(0, 0x02014b50, true); // Central directory signature
      cdView.setUint16(4, 20, true);         // Version made by: 2.0
      cdView.setUint16(6, 20, true);         // Version needed: 2.0
      cdView.setUint16(8, 0x0800, true);     // Flags: UTF-8
      cdView.setUint16(10, 0, true);         // Compression: STORE
      cdView.setUint16(12, dosTime, true);
      cdView.setUint16(14, dosDate, true);
      cdView.setUint32(16, fileCrc, true);
      cdView.setUint32(20, size, true);
      cdView.setUint32(24, size, true);
      cdView.setUint16(28, nameBytes.length, true);
      cdView.setUint16(30, 0, true);         // Extra field length
      cdView.setUint16(32, 0, true);         // Comment length
      cdView.setUint16(34, 0, true);         // Disk start
      cdView.setUint16(36, 0, true);         // Internal attributes
      cdView.setUint32(38, 0, true);         // External attributes
      cdView.setUint32(42, localOffset, true);// Relative offset of local header
      cdHeader.set(nameBytes, 46);

      centralDirs.push(cdHeader);
    }

    const cdStartOffset = offset;
    let cdTotalSize = 0;
    for (const cd of centralDirs) {
      cdTotalSize += cd.length;
    }

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdView.setUint16(4, 0, true);          // Disk number
    eocdView.setUint16(6, 0, true);          // CD disk
    eocdView.setUint16(8, this.files.length, true);  // Entries on disk
    eocdView.setUint16(10, this.files.length, true); // Total entries
    eocdView.setUint32(12, cdTotalSize, true);       // CD size
    eocdView.setUint32(16, cdStartOffset, true);     // CD offset
    eocdView.setUint16(20, 0, true);                 // Comment length

    // Assemble final buffer
    const totalLength = cdStartOffset + cdTotalSize + eocd.length;
    const finalBuffer = new Uint8Array(totalLength);
    let writePos = 0;

    for (const item of localHeaders) {
      finalBuffer.set(item.header, writePos);
      writePos += item.header.length;
      finalBuffer.set(item.data, writePos);
      writePos += item.data.length;
    }

    for (const cd of centralDirs) {
      finalBuffer.set(cd, writePos);
      writePos += cd.length;
    }

    finalBuffer.set(eocd, writePos);

    return finalBuffer;
  }

  /**
   * Generates a downloadable Blob in browser environments.
   * @param {string} [mimeType='application/zip']
   * @returns {Blob}
   */
  generateBlob(mimeType = 'application/zip') {
    const bytes = this.generateUint8Array();
    return new Blob([bytes], { type: mimeType });
  }
}
