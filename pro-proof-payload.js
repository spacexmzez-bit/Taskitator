// Proof files are already validated base64. Serialize them in chunks so hashing and
// provider calls don't allocate another full encoded copy of a large review.
function* jsonChunks(value) {
    if (Array.isArray(value)) {
        yield '[';
        for (let i = 0; i < value.length; i++) {
            if (i) yield ',';
            yield* jsonChunks(value[i] ?? null);
        }
        yield ']';
    } else if (value && typeof value === 'object') {
        yield '{';
        let first = true;
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined) continue;
            if (!first) yield ',';
            first = false;
            yield JSON.stringify(key) + ':';
            if (key === 'data' && typeof item === 'string' && item.length > 65536) {
                yield '"';
                for (let offset = 0; offset < item.length; offset += 65536) {
                    yield item.slice(offset, offset + 65536);
                }
                yield '"';
            } else {
                yield* jsonChunks(item);
            }
        }
        yield '}';
    } else {
        yield JSON.stringify(value);
    }
}

export function proofJSONStream(value) {
    const chunks = jsonChunks(value);
    const encoder = new TextEncoder();
    return new ReadableStream({
        pull(controller) {
            const chunk = chunks.next();
            if (chunk.done) controller.close();
            else controller.enqueue(encoder.encode(chunk.value));
        }
    });
}

export function proofRequestBody(value, largeProof) {
    return largeProof ? proofJSONStream(value) : JSON.stringify(value);
}
