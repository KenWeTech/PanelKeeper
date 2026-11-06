'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 22 + 0xffff;

const MAX_CENTRAL_DIRECTORY_BYTES = 128 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff']);

function zipError(message, code = 'ZIP_FORMAT_ERROR') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function decodeName(buffer, flags) {

    return buffer.toString((flags & 0x0800) ? 'utf8' : 'latin1').replace(/\\/g, '/');
}

async function readExactly(handle, buffer, position) {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
        if (!bytesRead) throw zipError('Unexpected end of ZIP archive. The download may be incomplete.');
        offset += bytesRead;
    }
    return buffer;
}

async function readZipDirectory(filePath) {
    const handle = await fsp.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        if (stat.size < 22) throw zipError('File is too small to be a valid ZIP/CBZ archive.');

        const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH);
        const tail = await readExactly(handle, Buffer.alloc(tailLength), stat.size - tailLength);
        let eocdIndex = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) !== EOCD_SIGNATURE) continue;
            const commentLength = tail.readUInt16LE(i + 20);
            if (i + 22 + commentLength <= tail.length) {
                eocdIndex = i;
                break;
            }
        }
        if (eocdIndex < 0) throw zipError('ZIP end record was not found. The file may be incomplete or corrupt.');

        const eocdAbsolute = stat.size - tailLength + eocdIndex;
        const eocd = Buffer.from(tail.subarray(eocdIndex, eocdIndex + 22));
        const diskNumber = eocd.readUInt16LE(4);
        const directoryDisk = eocd.readUInt16LE(6);
        const entriesOnDisk = eocd.readUInt16LE(8);
        const entryCount = eocd.readUInt16LE(10);
        const directorySize = eocd.readUInt32LE(12);
        const directoryOffset = eocd.readUInt32LE(16);
        const commentLength = eocd.readUInt16LE(20);

        if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
            throw zipError('Multi-disk ZIP archives are not supported. No files were changed.', 'MULTIDISK_UNSUPPORTED');
        }
        if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
            throw zipError('This is a ZIP64 archive. This operation safely skips ZIP64 files rather than risking damage.', 'ZIP64_UNSUPPORTED');
        }
        if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
            throw zipError(`ZIP central directory is larger than the safe ${Math.round(MAX_CENTRAL_DIRECTORY_BYTES / 1024 / 1024)} MiB parsing limit. The file was left unchanged.`, 'ZIP_DIRECTORY_TOO_LARGE');
        }
        if (directoryOffset + directorySize > eocdAbsolute || directoryOffset < 0 || directorySize < 0) {
            throw zipError('ZIP directory offsets are invalid. The file may be corrupt or still downloading.');
        }
        if (eocdAbsolute + 22 + commentLength > stat.size) {
            throw zipError('ZIP comment/end record is incomplete.');
        }

        const centralBuffer = await readExactly(handle, Buffer.alloc(directorySize), directoryOffset);
        const entries = [];
        let cursor = 0;
        for (let index = 0; index < entryCount; index++) {
            if (cursor + 46 > centralBuffer.length || centralBuffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
                throw zipError(`ZIP central directory is malformed at entry ${index + 1}.`);
            }
            const flags = centralBuffer.readUInt16LE(cursor + 8);
            const method = centralBuffer.readUInt16LE(cursor + 10);
            const crc32 = centralBuffer.readUInt32LE(cursor + 16);
            const compressedSize = centralBuffer.readUInt32LE(cursor + 20);
            const uncompressedSize = centralBuffer.readUInt32LE(cursor + 24);
            const nameLength = centralBuffer.readUInt16LE(cursor + 28);
            const extraLength = centralBuffer.readUInt16LE(cursor + 30);
            const entryCommentLength = centralBuffer.readUInt16LE(cursor + 32);
            const diskStart = centralBuffer.readUInt16LE(cursor + 34);
            const localOffset = centralBuffer.readUInt32LE(cursor + 42);
            const totalLength = 46 + nameLength + extraLength + entryCommentLength;
            if (cursor + totalLength > centralBuffer.length) throw zipError('ZIP directory entry extends beyond the directory bounds.');
            if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
                throw zipError('This archive contains ZIP64 entries. This operation safely skips ZIP64 files.', 'ZIP64_UNSUPPORTED');
            }
            const nameBuffer = centralBuffer.subarray(cursor + 46, cursor + 46 + nameLength);
            const name = decodeName(nameBuffer, flags);
            entries.push({
                index,
                name,
                flags,
                method,
                crc32,
                compressedSize,
                uncompressedSize,
                localOffset,
                centralStart: cursor,
                centralEnd: cursor + totalLength,
                centralLength: totalLength,
                isDirectory: name.endsWith('/'),
                encrypted: Boolean(flags & 1)
            });
            cursor += totalLength;
        }

        return {
            filePath,
            fileSize: stat.size,
            mtimeMs: stat.mtimeMs,
            entryCount,
            directorySize,
            directoryOffset,
            eocdAbsolute,
            eocd,
            comment: Buffer.from(tail.subarray(eocdIndex + 22, eocdIndex + 22 + commentLength)),
            centralBuffer,
            centralParsedLength: cursor,
            entries
        };
    } finally {
        await handle.close();
    }
}

function isComicInfo(entryName) {
    const normalized = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return !normalized.endsWith('/') && path.posix.basename(normalized).toLowerCase() === 'comicinfo.xml';
}

function imageEntries(directory, { includeManaged = false } = {}) {
    return directory.entries
        .filter(entry => !entry.isDirectory && !entry.encrypted && IMAGE_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase()) && (includeManaged || !isManagedFirstImage(entry.name)))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function displayImageName(entryName) {
    return String(entryName || '').replace(/^PKORDER-\d{8}__/i, '');
}

async function getEntryDataOffset(filePath, entry) {
    const handle = await fsp.open(filePath, 'r');
    try {
        const header = await readExactly(handle, Buffer.alloc(30), entry.localOffset);
        if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) throw zipError(`Invalid local ZIP header for ${entry.name}.`);
        const nameLength = header.readUInt16LE(26);
        const extraLength = header.readUInt16LE(28);
        return entry.localOffset + 30 + nameLength + extraLength;
    } finally {
        await handle.close();
    }
}

async function createEntryReadStream(filePath, entry) {
    if (entry.encrypted) throw zipError('This image is encrypted and cannot be previewed.');
    if (entry.method !== 0 && entry.method !== 8) throw zipError(`Compression method ${entry.method} is not supported for browser previews.`);
    const dataOffset = await getEntryDataOffset(filePath, entry);
    if (entry.compressedSize === 0) {
        const { PassThrough } = require('stream');
        const empty = new PassThrough();
        empty.end();
        return empty;
    }
    const input = fs.createReadStream(filePath, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 });
    if (entry.method === 0) return input;
    const inflater = zlib.createInflateRaw();
    input.on('error', error => inflater.destroy(error));
    return input.pipe(inflater);
}

async function copyRange(sourcePath, destinationPath, start, endExclusive) {
    if (endExclusive <= start) return;
    await pipeline(
        fs.createReadStream(sourcePath, { start, end: endExclusive - 1 }),
        fs.createWriteStream(destinationPath, { flags: 'a' })
    );
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function readComicInfoText(filePath, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const directory = await readZipDirectory(filePath);
    const entry = directory.entries.find(item => isComicInfo(item.name));
    if (!entry) return { exists: false, xml: '', entryName: '' };
    if (entry.encrypted) throw zipError('ComicInfo.xml is encrypted and cannot be read.');
    if (entry.uncompressedSize > maxBytes) throw zipError(`ComicInfo.xml is larger than the ${Math.round(maxBytes / 1024)} KiB safety limit.`);
    const stream = await createEntryReadStream(filePath, entry);
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > maxBytes) throw zipError(`ComicInfo.xml exceeded the ${Math.round(maxBytes / 1024)} KiB safety limit while reading.`);
        chunks.push(chunk);
    }
    return { exists: true, xml: Buffer.concat(chunks).toString('utf8'), entryName: entry.name };
}

function buildComicInfoZipRecords(xml, localOffset) {
    const data = Buffer.from(String(xml), 'utf8');
    if (!data.length || data.length > 256 * 1024) throw zipError('ComicInfo.xml must be between 1 byte and 256 KiB.');
    const name = Buffer.from('ComicInfo.xml', 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const now = new Date();
    const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
    const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    return { localRecord: Buffer.concat([local, compressed]), centralRecord: central };
}

async function writeComicInfoInPlace(filePath, xml) {
    const directory = await readZipDirectory(filePath);
    const targets = directory.entries.filter(entry => isComicInfo(entry.name));
    const targetIndices = new Set(targets.map(entry => entry.index));
    const localGroups = new Map();
    for (const entry of directory.entries) {
        if (!localGroups.has(entry.localOffset)) localGroups.set(entry.localOffset, []);
        localGroups.get(entry.localOffset).push(entry);
    }
    const removableOffsets = new Set();
    for (const entry of targets) {
        const group = localGroups.get(entry.localOffset) || [];
        if (group.every(candidate => targetIndices.has(candidate.index))) removableOffsets.add(entry.localOffset);
    }
    const orderedOffsets = [...localGroups.keys()].sort((a, b) => a - b);
    const ranges = [];
    for (const start of [...removableOffsets].sort((a, b) => a - b)) {
        const next = orderedOffsets.find(offset => offset > start);
        const end = next === undefined ? directory.directoryOffset : next;
        if (start < 0 || end <= start || end > directory.directoryOffset) throw zipError('ComicInfo.xml has an invalid local-record offset. No changes were made.');
        ranges.push({ start, end });
    }

    const removedLocalBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const keptEntries = directory.entries.filter(entry => !targetIndices.has(entry.index));
    const removedCentralBytes = targets.reduce((sum, entry) => sum + entry.centralLength, 0);
    const newLocalOffset = directory.directoryOffset - removedLocalBytes;
    const records = buildComicInfoZipRecords(xml, newLocalOffset);
    const newCentralEntries = keptEntries.map(entry => {
        const raw = Buffer.from(directory.centralBuffer.subarray(entry.centralStart, entry.centralEnd));
        const shift = ranges.reduce((sum, range) => sum + (range.end <= entry.localOffset ? range.end - range.start : 0), 0);
        const nextOffset = entry.localOffset - shift;
        if (nextOffset < 0 || nextOffset > 0xffffffff) throw zipError('The recalculated ZIP local offset is invalid. No changes were made.');
        raw.writeUInt32LE(nextOffset, 42);
        return raw;
    });
    newCentralEntries.push(records.centralRecord);
    const newCentral = Buffer.concat([...newCentralEntries, directory.centralBuffer.subarray(directory.centralParsedLength)]);
    const newDirectoryOffset = newLocalOffset + records.localRecord.length;
    const newDirectorySize = directory.directorySize - removedCentralBytes + records.centralRecord.length;
    const newEntryCount = keptEntries.length + 1;
    if (newDirectoryOffset > 0xffffffff || newDirectorySize > 0xffffffff || newEntryCount > 0xfffe) {
        throw zipError('Updated ZIP directory would exceed the supported standard ZIP limits. No changes were made.');
    }

    const patchedEocd = Buffer.from(directory.eocd);
    if (patchedEocd.readUInt16LE(8) === 0xffff || patchedEocd.readUInt16LE(10) === 0xffff) throw zipError('ZIP64 entry counts are not supported. No changes were made.', 'ZIP64_UNSUPPORTED');
    patchedEocd.writeUInt16LE(newEntryCount, 8);
    patchedEocd.writeUInt16LE(newEntryCount, 10);
    patchedEocd.writeUInt32LE(newCentral.length, 12);
    patchedEocd.writeUInt32LE(newDirectoryOffset, 16);

    const directoryTailStart = directory.directoryOffset + directory.directorySize;
    const tempPath = `${filePath}.panelkeeper-${process.pid}-${Date.now()}.tmp`;
    const backupPath = `${filePath}.panelkeeper-${process.pid}-${Date.now()}.bak`;
    await fsp.writeFile(tempPath, Buffer.alloc(0));
    try {
        let cursor = 0;
        for (const range of ranges) {
            await copyRange(filePath, tempPath, cursor, range.start);
            cursor = range.end;
        }
        await copyRange(filePath, tempPath, cursor, directory.directoryOffset);
        await fsp.appendFile(tempPath, records.localRecord);
        await fsp.appendFile(tempPath, newCentral);
        await copyRange(filePath, tempPath, directoryTailStart, directory.eocdAbsolute);
        await fsp.appendFile(tempPath, patchedEocd);
        await fsp.appendFile(tempPath, directory.comment);
        const expectedSize = directory.fileSize - removedLocalBytes - removedCentralBytes + records.localRecord.length + records.centralRecord.length;
        const actualSize = (await fsp.stat(tempPath)).size;
        if (actualSize !== expectedSize) throw zipError(`ZIP rewrite size check failed (${actualSize} bytes written; expected ${expectedSize}). Original was preserved.`);
        await fsp.rename(filePath, backupPath);
        try { await fsp.rename(tempPath, filePath); }
        catch (error) { await fsp.rename(backupPath, filePath).catch(() => {}); throw error; }
        await fsp.unlink(backupPath).catch(() => {});
        return { replacedCount: targets.length, added: true, bytesWritten: records.localRecord.length };
    } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function removeComicInfoInPlace(filePath) {
    const directory = await readZipDirectory(filePath);
    const targets = directory.entries.filter(entry => isComicInfo(entry.name));
    if (!targets.length) return { removedCount: 0, bytesSaved: 0 };

    const targetIndices = new Set(targets.map(entry => entry.index));
    const localGroups = new Map();
    for (const entry of directory.entries) {
        if (!localGroups.has(entry.localOffset)) localGroups.set(entry.localOffset, []);
        localGroups.get(entry.localOffset).push(entry);
    }

    const removableOffsets = new Set();
    for (const entry of targets) {
        const group = localGroups.get(entry.localOffset) || [];
        if (group.every(candidate => targetIndices.has(candidate.index))) removableOffsets.add(entry.localOffset);
    }
    const orderedOffsets = [...localGroups.keys()].sort((a, b) => a - b);
    const ranges = [];
    for (const start of [...removableOffsets].sort((a, b) => a - b)) {
        const next = orderedOffsets.find(offset => offset > start);
        const end = next === undefined ? directory.directoryOffset : next;
        if (start < 0 || end <= start || end > directory.directoryOffset) {
            throw zipError('ComicInfo.xml has an invalid local-record offset. No changes were made.');
        }
        ranges.push({ start, end });
    }

    const removedLocalBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const keptEntries = directory.entries.filter(entry => !targetIndices.has(entry.index));
    const removedCentralBytes = directory.entries.filter(entry => targetIndices.has(entry.index))
        .reduce((sum, entry) => sum + entry.centralLength, 0);
    const newCentralEntries = keptEntries.map(entry => {
        const raw = Buffer.from(directory.centralBuffer.subarray(entry.centralStart, entry.centralEnd));
        const shift = ranges.reduce((sum, range) => sum + (range.end <= entry.localOffset ? range.end - range.start : 0), 0);
        const newOffset = entry.localOffset - shift;
        if (newOffset < 0) throw zipError('The recalculated ZIP local offset is invalid. No changes were made.');
        raw.writeUInt32LE(newOffset, 42);
        return raw;
    });
    const newCentral = Buffer.concat([
        ...newCentralEntries,
        directory.centralBuffer.subarray(directory.centralParsedLength)
    ]);
    const newDirectoryOffset = directory.directoryOffset - removedLocalBytes;
    const newDirectorySize = directory.directorySize - removedCentralBytes;
    if (newDirectoryOffset < 0 || newDirectorySize < 0 || keptEntries.length > 0xfffe) {
        throw zipError('Updated ZIP directory would exceed the supported standard ZIP limits. No changes were made.');
    }

    const patchedEocd = Buffer.from(directory.eocd);
    const originalOnDisk = patchedEocd.readUInt16LE(8);
    const originalTotal = patchedEocd.readUInt16LE(10);
    if (originalOnDisk === 0xffff || originalTotal === 0xffff) throw zipError('ZIP64 entry counts are not supported. No changes were made.', 'ZIP64_UNSUPPORTED');
    patchedEocd.writeUInt16LE(Math.max(0, originalOnDisk - targets.length), 8);
    patchedEocd.writeUInt16LE(Math.max(0, originalTotal - targets.length), 10);
    patchedEocd.writeUInt32LE(newDirectorySize, 12);
    patchedEocd.writeUInt32LE(newDirectoryOffset, 16);

    const directoryTailStart = directory.directoryOffset + directory.directorySize;
    const tempPath = `${filePath}.panelkeeper-${process.pid}-${Date.now()}.tmp`;
    const backupPath = `${filePath}.panelkeeper-${process.pid}-${Date.now()}.bak`;
    await fsp.writeFile(tempPath, Buffer.alloc(0));

    try {
        let cursor = 0;
        for (const range of ranges) {
            await copyRange(filePath, tempPath, cursor, range.start);
            cursor = range.end;
        }
        await copyRange(filePath, tempPath, cursor, directory.directoryOffset);
        await fsp.appendFile(tempPath, newCentral);
        await copyRange(filePath, tempPath, directoryTailStart, directory.eocdAbsolute);
        await fsp.appendFile(tempPath, patchedEocd);
        await fsp.appendFile(tempPath, directory.comment);

        const expectedSize = directory.fileSize - removedLocalBytes - removedCentralBytes;
        const actualSize = (await fsp.stat(tempPath)).size;
        if (actualSize !== expectedSize) throw zipError(`ZIP rewrite size check failed (${actualSize} bytes written; expected ${expectedSize}). Original was preserved.`);

        await fsp.rename(filePath, backupPath);
        try {
            await fsp.rename(tempPath, filePath);
        } catch (error) {
            await fsp.rename(backupPath, filePath).catch(() => {});
            throw error;
        }
        await fsp.unlink(backupPath).catch(() => {});
        return { removedCount: targets.length, bytesSaved: removedLocalBytes + removedCentralBytes };
    } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});

        throw error;
    }
}

function imageSignature(entry) {
    return `${entry.crc32 >>> 0}:${entry.uncompressedSize}`;
}

function findOrderedSubsequence(shorter, longer) {
    const matches = [];
    let cursor = 0;
    for (const wanted of shorter) {
        while (cursor < longer.length && imageSignature(longer[cursor]) !== imageSignature(wanted)) cursor++;
        if (cursor >= longer.length) return null;
        matches.push(cursor);
        cursor++;
    }
    return matches;
}

async function hashEntry(filePath, entry) {
    const stream = await createEntryReadStream(filePath, entry);
    const hash = crypto.createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function compareImageCoverage(sourcePath, sourceDirectory, libraryPath, libraryDirectory, options = {}) {
    const sourcePages = imageEntries(sourceDirectory);
    const libraryPages = imageEntries(libraryDirectory);
    const maxPages = Math.max(1, Number(options.maxPages) || 600);
    const maxVerifyBytes = Math.max(1, Number(options.maxVerifyBytes) || 1024 * 1024 * 1024);

    if (!sourcePages.length || !libraryPages.length) {
        return { relation: 'ambiguous', reason: 'One or both archives contain no recognizable image pages.', sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
    }
    if (sourcePages.length > maxPages || libraryPages.length > maxPages) {
        return { relation: 'ambiguous', reason: `A version exceeds the ${maxPages}-image automatic comparison safety limit.`, sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
    }

    let shorter;
    let longer;
    let relation;
    if (sourcePages.length === libraryPages.length) {
        const sourceMatches = findOrderedSubsequence(sourcePages, libraryPages);
        if (!sourceMatches || sourceMatches.length !== libraryPages.length) {
            return { relation: 'ambiguous', reason: 'The image sequences differ; they cannot be safely ranked automatically.', sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
        }
        shorter = sourcePages;
        longer = libraryPages;
        relation = 'same';
    } else if (sourcePages.length > libraryPages.length) {
        const matches = findOrderedSubsequence(libraryPages, sourcePages);
        if (!matches) {
            return { relation: 'ambiguous', reason: 'Neither version is an exact ordered image-content superset of the other.', sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
        }
        shorter = libraryPages;
        longer = sourcePages;
        relation = 'source_superset';
    } else {
        const matches = findOrderedSubsequence(sourcePages, libraryPages);
        if (!matches) {
            return { relation: 'ambiguous', reason: 'Neither version is an exact ordered image-content superset of the other.', sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
        }
        shorter = sourcePages;
        longer = libraryPages;
        relation = 'library_superset';
    }

    const indexes = findOrderedSubsequence(shorter, longer);
    if (!indexes) {
        return { relation: 'ambiguous', reason: 'The image sequence changed during comparison.', sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
    }
    const verifiedBytes = shorter.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (verifiedBytes > maxVerifyBytes) {
        return { relation: 'ambiguous', reason: `Verifying matching pages would exceed the ${Math.round(maxVerifyBytes / 1024 / 1024)} MiB automatic comparison limit.`, sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
    }

    const shortPath = relation === 'source_superset' ? libraryPath : sourcePath;
    const longPath = relation === 'source_superset' ? sourcePath : libraryPath;
    for (let index = 0; index < shorter.length; index++) {
        const shortHash = await hashEntry(shortPath, shorter[index]);
        const longHash = await hashEntry(longPath, longer[indexes[index]]);
        if (shortHash !== longHash) {
            return { relation: 'ambiguous', reason: 'ZIP metadata matched but image-content verification did not.', sourcePageCount: sourcePages.length, libraryPageCount: libraryPages.length };
        }
    }

    if (relation === 'same') relation = 'identical';
    return {
        relation,
        reason: relation === 'identical'
            ? 'Both archives contain the exact same images in the same order.'
            : relation === 'source_superset'
                ? 'Every current library image is present byte-for-byte and in order in the downloaded archive, which also contains additional images.'
                : 'Every downloaded image is already present byte-for-byte and in order in the current library archive, which also contains additional images.',
        sourcePageCount: sourcePages.length,
        libraryPageCount: libraryPages.length,
        verifiedPages: shorter.length
    };
}

function isManagedFirstImage(name) {
    const base = path.posix.basename(String(name || '').replace(/\\/g, '/')).toLowerCase();
    return /^00000_panelkeeper_cover\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?)$/.test(base);
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

function createStoredZipEntry(name, data) {
    const nameBuffer = Buffer.from(name, 'utf8');
    if (!nameBuffer.length || nameBuffer.length > 0xffff) throw zipError('Managed cover filename is too long.');
    if (data.length > 0xffffffff) throw zipError('Cover image is too large for this standard ZIP archive.');
    const checksum = crc32(data);
    const stamp = dosDateTime();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(0, 42);
    return {
        localRecord: Buffer.concat([local, nameBuffer, data]),
        centralRecord: Buffer.concat([central, nameBuffer]),
        crc32: checksum,
        size: data.length
    };
}

async function rewriteZipEntries(filePath, removeEntries, appendEntry = null) {
    const directory = await readZipDirectory(filePath);
    const targetIndices = new Set(removeEntries.map(entry => entry.index));
    const localGroups = new Map();
    for (const entry of directory.entries) {
        if (!localGroups.has(entry.localOffset)) localGroups.set(entry.localOffset, []);
        localGroups.get(entry.localOffset).push(entry);
    }

    const removableOffsets = new Set();
    for (const entry of removeEntries) {
        const group = localGroups.get(entry.localOffset) || [];
        if (group.every(candidate => targetIndices.has(candidate.index))) removableOffsets.add(entry.localOffset);
    }
    const orderedOffsets = [...localGroups.keys()].sort((a, b) => a - b);
    const ranges = [];
    for (const start of [...removableOffsets].sort((a, b) => a - b)) {
        const next = orderedOffsets.find(offset => offset > start);
        const end = next === undefined ? directory.directoryOffset : next;
        if (start < 0 || end <= start || end > directory.directoryOffset) throw zipError('A managed ZIP entry has invalid local-record offsets. No changes were made.');
        ranges.push({ start, end });
    }

    const removedLocalBytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    const removedCentralBytes = removeEntries.reduce((sum, entry) => sum + entry.centralLength, 0);
    const keptEntries = directory.entries.filter(entry => !targetIndices.has(entry.index));
    if (keptEntries.length + (appendEntry ? 1 : 0) > 0xfffe) throw zipError('Updated ZIP would exceed the supported standard ZIP entry limit.');

    const newCentralEntries = keptEntries.map(entry => {
        const raw = Buffer.from(directory.centralBuffer.subarray(entry.centralStart, entry.centralEnd));
        const shift = ranges.reduce((sum, range) => sum + (range.end <= entry.localOffset ? range.end - range.start : 0), 0);
        const newOffset = entry.localOffset - shift;
        if (newOffset < 0) throw zipError('A recalculated ZIP offset is invalid. No changes were made.');
        raw.writeUInt32LE(newOffset, 42);
        return raw;
    });

    const newDirectoryOffset = directory.directoryOffset - removedLocalBytes + (appendEntry?.localRecord.length || 0);
    if (newDirectoryOffset > 0xffffffff) throw zipError('Updated ZIP exceeds the supported standard ZIP offset limit.');
    if (appendEntry) {
        appendEntry.centralRecord.writeUInt32LE(directory.directoryOffset - removedLocalBytes, 42);

        newCentralEntries.unshift(appendEntry.centralRecord);
    }
    const newCentral = Buffer.concat([
        ...newCentralEntries,
        directory.centralBuffer.subarray(directory.centralParsedLength)
    ]);
    const newDirectorySize = directory.directorySize - removedCentralBytes + (appendEntry?.centralRecord.length || 0);

    if (newDirectorySize < 0 || newDirectorySize > 0xffffffff) throw zipError('Updated ZIP central directory exceeds standard ZIP limits.');

    const patchedEocd = Buffer.from(directory.eocd);
    const originalOnDisk = patchedEocd.readUInt16LE(8);
    const originalTotal = patchedEocd.readUInt16LE(10);
    if (originalOnDisk === 0xffff || originalTotal === 0xffff) throw zipError('ZIP64 entry counts are not supported. No changes were made.', 'ZIP64_UNSUPPORTED');
    const newCount = originalTotal - removeEntries.length + (appendEntry ? 1 : 0);
    patchedEocd.writeUInt16LE(newCount, 8);
    patchedEocd.writeUInt16LE(newCount, 10);
    patchedEocd.writeUInt32LE(newDirectorySize, 12);
    patchedEocd.writeUInt32LE(newDirectoryOffset, 16);

    const directoryTailStart = directory.directoryOffset + directory.directorySize;
    const tempPath = `${filePath}.panelkeeper-${process.pid}-${Date.now()}.tmp`;
    const backupPath = `${filePath}.panelkeeper-${process.pid}-${Date.now()}.bak`;
    await fsp.writeFile(tempPath, Buffer.alloc(0));
    try {
        let cursor = 0;
        for (const range of ranges) {
            await copyRange(filePath, tempPath, cursor, range.start);
            cursor = range.end;
        }
        await copyRange(filePath, tempPath, cursor, directory.directoryOffset);
        if (appendEntry) await fsp.appendFile(tempPath, appendEntry.localRecord);
        await fsp.appendFile(tempPath, newCentral);
        await copyRange(filePath, tempPath, directoryTailStart, directory.eocdAbsolute);
        await fsp.appendFile(tempPath, patchedEocd);
        await fsp.appendFile(tempPath, directory.comment);

        const actualSize = (await fsp.stat(tempPath)).size;
        const expectedSize = directory.fileSize - removedLocalBytes - removedCentralBytes + (appendEntry?.localRecord.length || 0) + (appendEntry?.centralRecord.length || 0);
        if (actualSize !== expectedSize) throw zipError(`ZIP rewrite size check failed (${actualSize} bytes written; expected ${expectedSize}). Original was preserved.`);
        await fsp.rename(filePath, backupPath);
        try { await fsp.rename(tempPath, filePath); }
        catch (error) {
            await fsp.rename(backupPath, filePath).catch(() => {});
            throw error;
        }
        await fsp.unlink(backupPath).catch(() => {});
    } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function setManagedFirstImageInPlace(archivePath, imagePath) {
    const directory = await readZipDirectory(archivePath);
    const managedEntries = directory.entries.filter(entry => isManagedFirstImage(entry.name));
    if (!imagePath) {
        if (!managedEntries.length) return { changed: false, removed: 0 };
        await rewriteZipEntries(archivePath, managedEntries, null);
        return { changed: true, removed: managedEntries.length, action: 'removed' };
    }

    const extension = path.extname(imagePath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) throw zipError(`Unsupported cover image type: ${extension || '(no extension)'}`);
    const data = await fsp.readFile(imagePath);
    if (!data.length) throw zipError('The selected cover image is empty.');
    if (data.length > 64 * 1024 * 1024) throw zipError('Cover images larger than 64 MiB are not supported.');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const entryName = `00000_PanelKeeper_Cover${extension}`;
    if (managedEntries.length === 1 && managedEntries[0].name.toLowerCase() === entryName.toLowerCase()) {
        const existing = await hashEntry(archivePath, managedEntries[0]);
        if (existing === hash) return { changed: false, removed: 0, hash, action: 'unchanged' };
    }
    const appended = createStoredZipEntry(entryName, data);
    await rewriteZipEntries(archivePath, managedEntries, appended);
    return { changed: true, removed: managedEntries.length, hash, action: 'added' };
}

async function setManagedFirstImageBufferInPlace(archivePath, data, extension = '.jpg') {
    const directory = await readZipDirectory(archivePath);
    const managedEntries = directory.entries.filter(entry => isManagedFirstImage(entry.name));
    if (!Buffer.isBuffer(data) || !data.length) throw zipError('Generated cover image is empty.');
    if (data.length > 64 * 1024 * 1024) throw zipError('Generated cover images larger than 64 MiB are not supported.');
    const normalizedExtension = String(extension || '.jpg').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(normalizedExtension)) throw zipError(`Unsupported generated cover image type: ${normalizedExtension}`);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const entryName = `00000_PanelKeeper_Cover${normalizedExtension}`;
    if (managedEntries.length === 1 && managedEntries[0].name.toLowerCase() === entryName.toLowerCase()) {
        const existing = await hashEntry(archivePath, managedEntries[0]);
        if (existing === hash) return { changed: false, removed: 0, hash, action: 'unchanged' };
    }
    const appended = createStoredZipEntry(entryName, data);
    await rewriteZipEntries(archivePath, managedEntries, appended);
    return { changed: true, removed: managedEntries.length, hash, action: 'added' };
}

async function removeManagedFirstImageInPlace(archivePath) {
    return setManagedFirstImageInPlace(archivePath, null);
}

async function deleteEntryInPlace(filePath, entryIndex) {
    const directory = await readZipDirectory(filePath);
    const target = directory.entries.find(entry => entry.index === Number(entryIndex));
    if (!target) throw zipError('The selected archive entry no longer exists. Refresh the page list and try again.');
    await rewriteZipEntries(filePath, [target], null);
    return { removed: 1, name: target.name };
}

async function reorderImageEntriesInPlace(filePath, orderedEntryIndices) {
    if (!Array.isArray(orderedEntryIndices)) throw zipError('A page order list is required.');
    const directory = await readZipDirectory(filePath);
    const pages = imageEntries(directory);
    const expected = new Set(pages.map(entry => entry.index));
    const order = orderedEntryIndices.map(Number);
    if (order.length !== pages.length || new Set(order).size !== order.length || order.some(index => !expected.has(index))) {
        throw zipError('The page order is incomplete or contains duplicate/unknown page entries. Refresh the viewer and try again.');
    }
    if (pages.length > 99999999) throw zipError('This archive contains too many pages to order safely.');

    const entryByIndex = new Map(pages.map(entry => [entry.index, entry]));
    const renameByIndex = new Map();
    order.forEach((entryIndex, position) => {
        const entry = entryByIndex.get(entryIndex);
        const originalName = entry.name.replace(/^PKORDER-\d{8}__/i, '');
        const newName = `PKORDER-${String(position + 1).padStart(8, '0')}__${originalName}`;
        if (Buffer.byteLength(newName, 'utf8') > 0xffff) throw zipError(`The image filename is too long to safely reorder: ${entry.name}`);
        renameByIndex.set(entryIndex, newName);
    });

    let changed = false;
    for (const [entryIndex, name] of renameByIndex) {
        if (entryByIndex.get(entryIndex).name !== name) { changed = true; break; }
    }
    if (!changed) return { changed: false, pageCount: pages.length };

    const handle = await fsp.open(filePath, 'r');
    let handleOpen = true;
    const tempPath = `${filePath}.panelkeeper-order-${process.pid}-${Date.now()}.tmp`;
    const backupPath = `${filePath}.panelkeeper-order-${process.pid}-${Date.now()}.bak`;
    try {
        const localGroups = new Map();
        for (const entry of directory.entries) {
            if (!localGroups.has(entry.localOffset)) localGroups.set(entry.localOffset, []);
            localGroups.get(entry.localOffset).push(entry);
        }
        const offsets = [...localGroups.keys()].sort((a, b) => a - b);
        const records = [];
        let localNameDelta = 0;
        const newOffsets = new Map();

        for (let position = 0; position < offsets.length; position++) {
            const start = offsets[position];
            const end = position + 1 < offsets.length ? offsets[position + 1] : directory.directoryOffset;
            const group = localGroups.get(start);
            if (group.length !== 1 && group.some(entry => renameByIndex.has(entry.index))) {
                throw zipError('This archive has shared ZIP payload entries. Page ordering is skipped to protect the shared data.');
            }
            const entry = group[0];
            const fixed = await readExactly(handle, Buffer.alloc(30), start);
            if (fixed.readUInt32LE(0) !== LOCAL_SIGNATURE) throw zipError(`Invalid local ZIP header for ${entry.name}; no changes were made.`);
            const oldNameLength = fixed.readUInt16LE(26);
            const extraLength = fixed.readUInt16LE(28);
            const oldName = await readExactly(handle, Buffer.alloc(oldNameLength), start + 30);
            const extra = await readExactly(handle, Buffer.alloc(extraLength), start + 30 + oldNameLength);
            const newName = renameByIndex.has(entry.index) ? Buffer.from(renameByIndex.get(entry.index), 'utf8') : oldName;
            const patchedFixed = Buffer.from(fixed);
            patchedFixed.writeUInt16LE(newName.length, 26);
            if (renameByIndex.has(entry.index)) patchedFixed.writeUInt16LE(patchedFixed.readUInt16LE(6) | 0x0800, 6);
            const dataStart = start + 30 + oldNameLength + extraLength;
            const dataEnd = dataStart + entry.compressedSize;
            if (dataEnd > end || dataStart < start) throw zipError(`Invalid compressed data bounds for ${entry.name}; no changes were made.`);
            const localRecordLength = 30 + newName.length + extraLength + (end - dataEnd) + entry.compressedSize;
            localNameDelta += newName.length - oldName.length;
            records.push({ start, end, entry, fixed: patchedFixed, name: newName, extra, dataStart, dataEnd, localRecordLength });
        }

        await fsp.writeFile(tempPath, Buffer.alloc(0));
        const firstOffset = offsets.length ? offsets[0] : directory.directoryOffset;
        await copyRange(filePath, tempPath, 0, firstOffset);
        let outputOffset = firstOffset;
        for (const record of records) {
            const oldGroup = localGroups.get(record.start);
            for (const entry of oldGroup) newOffsets.set(entry.index, outputOffset);
            await fsp.appendFile(tempPath, record.fixed);
            await fsp.appendFile(tempPath, record.name);
            await fsp.appendFile(tempPath, record.extra);
            await copyRange(filePath, tempPath, record.dataStart, record.dataEnd);
            await copyRange(filePath, tempPath, record.dataEnd, record.end);
            outputOffset += record.localRecordLength;
        }

        const centralRecordsByIndex = new Map();
        let centralNameDelta = 0;
        for (const entry of directory.entries) {
            const raw = Buffer.from(directory.centralBuffer.subarray(entry.centralStart, entry.centralEnd));
            const oldNameLength = raw.readUInt16LE(28);
            const extraLength = raw.readUInt16LE(30);
            const nameStart = 46;
            const oldName = raw.subarray(nameStart, nameStart + oldNameLength);
            const replacement = renameByIndex.has(entry.index) ? Buffer.from(renameByIndex.get(entry.index), 'utf8') : oldName;
            const fixed = Buffer.from(raw.subarray(0, 46));
            fixed.writeUInt16LE(replacement.length, 28);
            if (renameByIndex.has(entry.index)) fixed.writeUInt16LE(fixed.readUInt16LE(8) | 0x0800, 8);
            const tail = raw.subarray(nameStart + oldNameLength);
            const rebuilt = Buffer.concat([fixed, replacement, tail]);
            const newOffset = newOffsets.get(entry.index);
            if (!Number.isInteger(newOffset) || newOffset > 0xffffffff) throw zipError('A recalculated ZIP offset is invalid. No changes were made.');
            rebuilt.writeUInt32LE(newOffset, 42);
            centralRecordsByIndex.set(entry.index, rebuilt);
            centralNameDelta += replacement.length - oldName.length;
        }

        const managedEntries = directory.entries.filter(entry => isManagedFirstImage(entry.name));
        const orderedPageEntries = order.map(index => entryByIndex.get(index));
        const orderedImageIndexSet = new Set(order);
        const managedIndexSet = new Set(managedEntries.map(entry => entry.index));
        const otherEntries = directory.entries.filter(entry => !orderedImageIndexSet.has(entry.index) && !managedIndexSet.has(entry.index));
        const centralOutputOrder = [...managedEntries, ...orderedPageEntries, ...otherEntries];
        const centralRecords = centralOutputOrder.map(entry => centralRecordsByIndex.get(entry.index)).filter(Boolean);
        const centralTail = directory.centralBuffer.subarray(directory.centralParsedLength);
        const newCentral = Buffer.concat([...centralRecords, centralTail]);
        const patchedEocd = Buffer.from(directory.eocd);
        const totalEntries = patchedEocd.readUInt16LE(10);
        if (totalEntries === 0xffff) throw zipError('ZIP64 entry counts are not supported. No changes were made.', 'ZIP64_UNSUPPORTED');
        patchedEocd.writeUInt32LE(newCentral.length, 12);
        patchedEocd.writeUInt32LE(outputOffset, 16);
        const directoryTailStart = directory.directoryOffset + directory.directorySize;
        await fsp.appendFile(tempPath, newCentral);
        await copyRange(filePath, tempPath, directoryTailStart, directory.eocdAbsolute);
        await fsp.appendFile(tempPath, patchedEocd);
        await fsp.appendFile(tempPath, directory.comment);

        const expectedSize = directory.fileSize + localNameDelta + centralNameDelta;
        const actualSize = (await fsp.stat(tempPath)).size;
        if (actualSize !== expectedSize) throw zipError(`Page-order rewrite size check failed (${actualSize} bytes written; expected ${expectedSize}). Original archive was preserved.`);

        await handle.close();
        handleOpen = false;
        await fsp.rename(filePath, backupPath);
        try { await fsp.rename(tempPath, filePath); }
        catch (error) {
            await fsp.rename(backupPath, filePath).catch(() => {});
            throw error;
        }
        await fsp.unlink(backupPath).catch(() => {});
        return { changed: true, pageCount: pages.length };
    } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
    } finally {
        if (handleOpen) await handle.close().catch(() => {});
    }
}

function mimeTypeForImage(name) {
    switch (path.posix.extname(name).toLowerCase()) {
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.png': return 'image/png';
        case '.webp': return 'image/webp';
        case '.gif': return 'image/gif';
        case '.avif': return 'image/avif';
        case '.bmp': return 'image/bmp';
        case '.tif':
        case '.tiff': return 'image/tiff';
        default: return 'application/octet-stream';
    }
}

module.exports = {
    readZipDirectory,
    readComicInfoText,
    writeComicInfoInPlace,
    isComicInfo,
    imageEntries,
    displayImageName,
    deleteEntryInPlace,
    reorderImageEntriesInPlace,
    compareImageCoverage,
    createEntryReadStream,
    getEntryDataOffset,
    removeComicInfoInPlace,
    setManagedFirstImageInPlace,
    setManagedFirstImageBufferInPlace,
    removeManagedFirstImageInPlace,
    isManagedFirstImage,
    mimeTypeForImage,
    zipError
};
