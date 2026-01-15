export class FileCompressor {
  async #streamToBlob(stream) {
    try {
      const reader = stream.getReader();
      const chunks = [];
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      
      reader.releaseLock();
      return new Blob(chunks);
    } catch (error) {
      console.error('Error in streamToBlob:', error);
      throw error;
    }
  }

  #writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  #writeUint32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  #encodeFilename(filename) {
    return new TextEncoder().encode(filename);
  }

  #calculateCRC32(data) {
    const crcTable = [];
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
      }
      crcTable[i] = crc;
    }

    let crc = 0xFFFFFFFF;
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  async #createZipFromFiles(files) {
    const parts = [];
    const centralHeaders = [];
    const adler32Map = new Map(); // Store Adler-32 for each file
    let offset = 0;

    for (const file of files) {
      const filenameBytes = this.#encodeFilename(file.name);
      const fileDataBuffer = await file.arrayBuffer();
      const crc32 = this.#calculateCRC32(fileDataBuffer);
      
      let compressedBlob;
      try {
        const compressionStream = new CompressionStream('deflate');
        const writer = compressionStream.writable.getWriter();
        
        const readPromise = this.#streamToBlob(compressionStream.readable).catch(err => {
          console.error(`Error reading stream for ${file.name}:`, err);
          throw err;
        });
        
        await writer.write(new Uint8Array(fileDataBuffer));
        await writer.close();
        
        compressedBlob = await readPromise;
      } catch (error) {
        console.error(`Error compressing ${file.name}:`, error);
        throw error;
      }
      let compressedDataBuffer = await compressedBlob.arrayBuffer();
      
      const compressedView = new Uint8Array(compressedDataBuffer);
      let compressedData;
      // CompressionStream('deflate') produces zlib-wrapped deflate, but ZIP format requires raw deflate
      // Strip zlib wrapper (2-byte header + 4-byte Adler-32 footer) for OS compatibility
      if (compressedView.length >= 6 && compressedView[0] === 0x78) {
        // Extract Adler-32 before stripping (needed for browser decompression)
        const adler32View = new DataView(compressedDataBuffer, compressedDataBuffer.byteLength - 4);
        const adler32 = adler32View.getUint32(0, false); // Big-endian
        adler32Map.set(file.name, adler32);
        
        // Strip zlib header (2 bytes) and footer (4 bytes) to get raw deflate
        compressedData = new Uint8Array(compressedDataBuffer.slice(2, compressedDataBuffer.byteLength - 4));
      } else {
        compressedData = new Uint8Array(compressedDataBuffer);
      }
      
      const compressedSize = compressedData.byteLength;
      const uncompressedSize = fileDataBuffer.byteLength;

      const localHeaderSize = 30 + filenameBytes.length;
      const localHeader = new ArrayBuffer(localHeaderSize);
      const localView = new DataView(localHeader);
      
      this.#writeUint32(localView, 0, 0x04034b50);
      this.#writeUint16(localView, 4, 20);
      this.#writeUint16(localView, 6, 0);
      this.#writeUint16(localView, 8, 8);
      this.#writeUint16(localView, 10, 0);
      this.#writeUint32(localView, 14, crc32);
      this.#writeUint32(localView, 18, compressedSize);
      this.#writeUint32(localView, 22, uncompressedSize);
      this.#writeUint16(localView, 26, filenameBytes.length);
      this.#writeUint16(localView, 28, 0);
      
      new Uint8Array(localHeader, 30).set(filenameBytes);
      
      // Add local header and file data immediately (ZIP format requires them together)
      parts.push(localHeader);
      parts.push(compressedData);
      
      // Store Adler-32 in comment field (4 bytes as hex string)
      const adler32 = adler32Map.get(file.name) || 0;
      const adler32Hex = adler32.toString(16).padStart(8, '0');
      const commentBytes = new TextEncoder().encode(adler32Hex);
      
      const centralHeaderSize = 46 + filenameBytes.length + commentBytes.length;
      const centralHeader = new ArrayBuffer(centralHeaderSize);
      const centralView = new DataView(centralHeader);
      
      this.#writeUint32(centralView, 0, 0x02014b50);
      this.#writeUint16(centralView, 4, 20);
      this.#writeUint16(centralView, 6, 20);
      this.#writeUint16(centralView, 8, 0);
      this.#writeUint16(centralView, 10, 8);
      this.#writeUint16(centralView, 12, 0); // Last mod file time
      this.#writeUint16(centralView, 14, 0); // Last mod file date
      this.#writeUint32(centralView, 16, crc32);
      this.#writeUint32(centralView, 20, compressedSize);
      this.#writeUint32(centralView, 24, uncompressedSize);
      this.#writeUint16(centralView, 28, filenameBytes.length);
      this.#writeUint16(centralView, 30, 0); // Extra field length
      this.#writeUint16(centralView, 32, commentBytes.length);
      this.#writeUint16(centralView, 34, 0); // Disk number start
      this.#writeUint16(centralView, 36, 0); // Internal file attributes
      this.#writeUint32(centralView, 38, 0); // External file attributes
      this.#writeUint32(centralView, 42, offset);
      
      new Uint8Array(centralHeader, 46).set(filenameBytes);
      new Uint8Array(centralHeader, 46 + filenameBytes.length).set(commentBytes);
      
      centralHeaders.push(centralHeader);
      offset += localHeaderSize + compressedSize;
    }

    const centralDirStart = offset;
    const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.byteLength, 0);
    
    // Add central directory headers
    parts.push(...centralHeaders);
    
    const endOfCentralDir = new ArrayBuffer(22);
    const endView = new DataView(endOfCentralDir);
    this.#writeUint32(endView, 0, 0x06054b50);
    this.#writeUint16(endView, 4, 0);
    this.#writeUint16(endView, 6, 0);
    this.#writeUint16(endView, 8, files.length);
    this.#writeUint16(endView, 10, files.length);
    this.#writeUint32(endView, 12, centralDirSize);
    this.#writeUint32(endView, 16, centralDirStart);
    this.#writeUint16(endView, 20, 0);

    // Add end of central directory
    parts.push(endOfCentralDir);

    return new Blob(parts, { type: 'application/zip' });
  }

  async #compressSingleFile(file) {
    const fileStream = file.stream();
    const compressedFileStream = fileStream.pipeThrough(new CompressionStream('deflate'));
    return await this.#streamToBlob(compressedFileStream);
  }

  async compress(files) {
    return await (Array.isArray(files) ? this.#createZipFromFiles(files) : this.#compressSingleFile(files));
  }
}