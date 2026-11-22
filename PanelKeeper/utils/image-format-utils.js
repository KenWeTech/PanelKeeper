'use strict';

const SUPPORTED_PAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const supported = new Set(SUPPORTED_PAGE_EXTENSIONS);

const knownImageExtensions = new Set([
    ...SUPPORTED_PAGE_EXTENSIONS,
    '.jxl', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.svg',
    '.jp2', '.j2k', '.jpf', '.jpx', '.jpm', '.jng', '.jpe', '.jfif',
    '.psd', '.qoi', '.apng', '.ico', '.tga', '.exr', '.dds', '.jxr',
    '.wdp', '.hdp', '.bpg', '.flif', '.pcx', '.pbm', '.pgm', '.ppm',
    '.pnm', '.xbm', '.xpm', '.dng', '.cr2', '.nef', '.arw', '.orf',
    '.rw2', '.avifs'
]);

function isRecognizedImageExtension(extension) {
    return knownImageExtensions.has(String(extension || '').toLowerCase());
}

function isSupportedPageExtension(extension) {
    return supported.has(String(extension || '').toLowerCase());
}

function unsupportedImagesInDirectory(directory) {
    if (!directory || !Array.isArray(directory.entries)) return [];
    const found = [];
    for (const entry of directory.entries) {
        if (!entry || entry.isDirectory) continue;
        const name = String(entry.name || '').replace(/\\/g, '/');

        if (!name || name.split('/').some(part => part.toLowerCase() === '__macosx')) continue;
        const lastDot = name.lastIndexOf('.');
        if (lastDot < 0 || lastDot < name.lastIndexOf('/')) continue;
        const extension = name.slice(lastDot).toLowerCase();
        if (!knownImageExtensions.has(extension) || supported.has(extension)) continue;
        found.push({ name, extension });
    }
    return found;
}

function describeUnsupportedImages(entries) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const counts = new Map();
    for (const item of entries) {
        const label = item.extension.slice(1).toUpperCase();
        counts.set(label, (counts.get(label) || 0) + 1);
    }
    const summary = [...counts].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name} (${count})`).join(', ');
    const examples = entries.slice(0, 5).map(item => String(item.name).slice(-110)).join(', ');
    return `Unsupported image pages found inside CBZ: ${summary}. Example entries: ${examples}${entries.length > 5 ? ` (and ${entries.length - 5} more)` : ''}. Other unsupported page entries still require review.`;
}

module.exports = { SUPPORTED_PAGE_EXTENSIONS, isRecognizedImageExtension, isSupportedPageExtension, unsupportedImagesInDirectory, describeUnsupportedImages };
