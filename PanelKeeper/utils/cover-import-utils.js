'use strict';

const path = require('node:path');

const IMAGE_TYPES = {
    'image/jpeg': { extension: '.jpg', matches: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    'image/png': { extension: '.png', matches: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    'image/webp': { extension: '.webp', matches: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
    'image/gif': { extension: '.gif', matches: buffer => buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)) },
    'image/avif': { extension: '.avif', matches: buffer => buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis|mif1|msf1)$/.test(buffer.toString('ascii', 8, 12)) },
    'image/bmp': { extension: '.bmp', matches: buffer => buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM' },
    'image/tiff': { extension: '.tiff', matches: buffer => buffer.length >= 4 && ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) || (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)) }
};

function normalizeMimeType(value, originalFilename = '') {
    const supplied = String(value || '').split(';', 1)[0].trim().toLowerCase();
    if (supplied === 'image/x-tiff') return 'image/tiff';
    if (supplied && supplied !== 'application/octet-stream') return supplied;
    const extension = path.extname(String(originalFilename || '')).toLowerCase();
    return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff' })[extension] || supplied;
}

function validateCoverUpload(buffer, contentType, originalFilename, maxBytes = 40 * 1024 * 1024) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Choose a non-empty image file to import.');
    if (buffer.length > maxBytes) throw new Error(`Cover image exceeds the ${Math.round(maxBytes / (1024 * 1024))} MiB upload limit.`);
    const mime = normalizeMimeType(contentType, originalFilename);
    const type = IMAGE_TYPES[mime];
    if (!type) throw new Error('Unsupported image type. Use JPEG, PNG, WebP, GIF, AVIF, BMP, or TIFF.');
    if (!type.matches(buffer)) throw new Error('The uploaded file content does not match its image type. The file was not saved.');
    const suppliedExtension = path.extname(String(originalFilename || '')).toLowerCase();
    const validExtensions = {
        'image/jpeg': ['.jpg', '.jpeg'],
        'image/png': ['.png'],
        'image/webp': ['.webp'],
        'image/gif': ['.gif'],
        'image/avif': ['.avif'],
        'image/bmp': ['.bmp'],
        'image/tiff': ['.tif', '.tiff']
    }[mime];
    if (suppliedExtension && !validExtensions.includes(suppliedExtension)) {
        throw new Error(`The file extension ${suppliedExtension} does not match ${mime}.`);
    }
    return { mimeType: mime, extension: type.extension, originalName: path.basename(String(originalFilename || 'cover')) };
}

module.exports = { IMAGE_TYPES, normalizeMimeType, validateCoverUpload };
