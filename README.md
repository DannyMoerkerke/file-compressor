# FileCompressor

A component that compresses one or more files into a zip-archive in the browser. It uses the 
native [CompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/Compression_Streams_API) to compress files.

## Usage
```
const compressor = new FileCompressor();

const blob = await compressor.compress(files: Files[]): Promise<Blob>; 
```

`CompressionStream` has baseline availability.
