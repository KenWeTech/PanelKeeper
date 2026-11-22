'use strict';

const path = require('path');

const MAX_JXL_INPUT_BYTES = 48 * 1024 * 1024;
const MAX_ZIP_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_JXL_PIXELS = 40_000_000;

const MAX_LOSSLESS_WEBP_DIMENSION = 16_384;
const MAX_CONCURRENT_PREVIEWS = 2;
const MAX_QUEUED_PREVIEWS = 32;
let activePreviews = 0;
const waiting = [];

function isJxlPage(name) {
    return path.extname(String(name || '')).toLowerCase() === '.jxl';
}

function previewError(message, status = 422) {
    const error = new Error(message);
    error.status = status;
    return error;
}

async function withPreviewSlot(fn) {
    if (activePreviews >= MAX_CONCURRENT_PREVIEWS) {
        if (waiting.length >= MAX_QUEUED_PREVIEWS) {
            throw previewError('Too many simultaneous JXL previews. Open fewer pages and retry.', 503);
        }
        await new Promise(resolve => waiting.push(resolve));
    } else {
        activePreviews += 1;
    }
    try {
        return await fn();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else activePreviews -= 1;
    }
}

async function readLimitedStream(stream, declaredSize) {
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > MAX_JXL_INPUT_BYTES) {

        stream.destroy();
        throw previewError('This JXL page exceeds the safe preview input size or is empty.');
    }
    const parts = [];
    let length = 0;
    try {
        for await (const chunk of stream) {
            length += chunk.length;
            if (length > MAX_JXL_INPUT_BYTES) {
                stream.destroy();
                throw previewError('The decompressed JXL page exceeds the safe preview input limit.');
            }
            parts.push(chunk);
        }
    } catch (error) {
        if (error.status) throw error;
        throw previewError(`Unable to read the JXL page: ${error.message}`);
    }
    if (length !== declaredSize) throw previewError('The JXL page is incomplete or its ZIP directory size is incorrect.');
    return Buffer.concat(parts, length);
}

function isLosslessWebP(data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WEBP' ||
        bytes.readUInt32LE(4) !== bytes.length - 8) return false;
    let offset = 12;
    let extended = false;
    let frameCount = 0;
    let count = 0;
    while (offset + 8 <= bytes.length) {
        const tag = bytes.toString('ascii', offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + length;
        if (end > bytes.length || !Number.isSafeInteger(end)) return false;
        count++;
        if (tag === 'VP8X') {
            if (count !== 1 || extended || length !== 10 || (bytes[start] & 0x02)) return false;
            extended = true;
        } else if (tag === 'VP8L') {
            if (++frameCount !== 1 || length < 5 || bytes[start] !== 0x2f) return false;
        } else if (tag === 'VP8 ' || tag === 'ALPH' || tag === 'ANIM' || tag === 'ANMF') {
            return false;
        } else if (!extended || !['ICCP', 'EXIF', 'XMP '].includes(tag)) {
            return false;
        }
        offset = end + (length & 1);
    }
    return offset === bytes.length && frameCount === 1 && (extended || count === 1);
}

async function encodeDecodedPreview(decoded) {
    const width = Number(decoded?.width);
    const height = Number(decoded?.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width * height > MAX_JXL_PIXELS) {
        throw new Error('The decoded JXL image has invalid or unsafe dimensions.');
    }

    const encodePng = async () => {
        const data = Buffer.from(await decoded.encodePNG());
        if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
            throw new Error('PNG fallback did not produce a valid PNG header.');
        }
        return { data, contentType: 'image/png' };
    };

    if (width > MAX_LOSSLESS_WEBP_DIMENSION || height > MAX_LOSSLESS_WEBP_DIMENSION) {
        return encodePng();
    }

    try {
        const data = Buffer.from(await decoded.encodeWebP({ effort: 1, threads: 1 }));
        if (!isLosslessWebP(data)) {

            throw new Error('WebP encoder output was not a valid lossless VP8L image.');
        }
        return { data, contentType: 'image/webp' };
    } catch (webpError) {
        try {
            return await encodePng();
        } catch (pngError) {
            throw new Error(`Lossless WebP encoding failed (${webpError.message}); PNG fallback failed (${pngError.message}).`);
        }
    }
}

async function previewJxlEntry(zip, archivePath, entry) {
    if (!isJxlPage(entry?.name)) throw previewError('Only JXL pages can use this preview decoder.');
    if (entry.encrypted || ![0, 8].includes(entry.method)) throw previewError('This JXL page uses unsupported ZIP encryption or compression.');
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1 || entry.uncompressedSize > MAX_JXL_INPUT_BYTES) {
        throw previewError('This JXL page exceeds the safe preview input size or is empty.');
    }
    if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 1 || entry.compressedSize > MAX_ZIP_COMPRESSED_BYTES) {
        throw previewError("This JXL page exceeds the safe ZIP compressed size or is empty.");
    }
    return withPreviewSlot(async () => {
        const input = await readLimitedStream(await zip.createEntryReadStream(archivePath, entry), entry.uncompressedSize);
        let Image;
        try {
            ({ Image } = require('imagescript'));
        } catch (error) {
            throw previewError('JXL preview is unavailable. Install the project dependencies and restart PanelKeeper.', 503);
        }
        try {
            const decoded = await Image.decode(input, { maxPixels: MAX_JXL_PIXELS, threads: 1 });

            return await encodeDecodedPreview(decoded);
        } catch (error) {
            throw previewError(`Could not preview this JXL page: ${error.message}`);
        }
    });
}

module.exports = { isJxlPage, previewJxlEntry, encodeDecodedPreview, isLosslessWebP, MAX_JXL_INPUT_BYTES, MAX_JXL_PIXELS, MAX_LOSSLESS_WEBP_DIMENSION };
