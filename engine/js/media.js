// Media bytes appended in the engine travel to the host's SourceBuffer as a
// transferred copy; the wasm heap is shared memory and cannot be transferred.
addToLibrary({
  inception_media_append: (player, sourceBuffer, seq, data, length) => {
    const bytes = HEAPU8.slice(data, data + length);
    postMessage({ inceptionMediaAppend: { id: player, sb: sourceBuffer, seq, bytes } }, [bytes.buffer]);
  },
});
