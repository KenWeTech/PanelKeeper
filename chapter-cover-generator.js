'use strict';

const fs = require('node:fs/promises');

const POSITIONS = new Set([
    'top-left', 'top-center', 'top-right',
    'middle-left', 'center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right'
]);
const HEX = /^#[0-9a-f]{6}$/i;

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeDesign(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const position = POSITIONS.has(String(source.position || '')) ? String(source.position) : 'top-center';
    return {
        position,
        template: String(source.template || 'Chapter {number}').slice(0, 120),
        fontSize: clamp(source.fontSize, 2.5, 14, 6),
        textColor: HEX.test(String(source.textColor || '')) ? String(source.textColor) : '#ffffff',
        outlineColor: HEX.test(String(source.outlineColor || '')) ? String(source.outlineColor) : '#000000',
        outlineWidth: clamp(source.outlineWidth, 0, 10, 3),
        panelEnabled: source.panelEnabled === true || source.panelEnabled === 1 || source.panelEnabled === 'true',
        panelColor: HEX.test(String(source.panelColor || '')) ? String(source.panelColor) : '#000000',
        panelOpacity: clamp(source.panelOpacity, 0, 0.95, 0.48),
        updatedAt: source.updatedAt || null
    };
}

function normalizeKavitaAutoCoverDesign(input = {}) {
    const current = normalizeDesign(input);
    return normalizeDesign({
        ...current,
        position: 'bottom-center',
        fontSize: Math.max(10, current.fontSize),

        panelEnabled: true,
        panelOpacity: 0.35
    });
}

function xmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function formatTemplate(template, chapter, series) {
    const sourceTemplate = String(template || 'Chapter {number}').trim();

    if (chapter?.special && /^chapter\s+\{number\}$/i.test(sourceTemplate)) {
        return String(chapter.label || 'Special').trim();
    }
    const number = chapter && chapter.number != null
        ? `${chapter.numberText || chapter.number}${chapter.letterSuffix || ''}`
        : String(chapter?.label || 'Special');
    const volume = chapter?.volumeNumber != null && Number.isFinite(Number(chapter.volumeNumber))
        ? String(Number(chapter.volumeNumber)).replace(/^(\d)$/, '0$1')
        : String(chapter?.volumeLabel || chapter?.volumeKey || '').replace(/^volume\s*/i, '').trim();
    const values = {
        chapter: chapter?.label || 'Special',
        number,
        title: chapter?.additionalText || '',
        series: series || '',
        volume
    };
    return sourceTemplate.replace(/\{(chapter|number|title|series|volume)\}/gi, (_, key) => values[key.toLowerCase()] || '').replace(/\s+/g, ' ').trim();
}

function wrapText(text, maxChars = 32, maxLines = 3) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (next.length > maxChars && line) {
            lines.push(line);
            line = word;
        } else line = next;
        if (lines.length >= maxLines) break;
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (words.length && lines.length) {
        const rendered = lines.join(' ');
        const original = words.join(' ');
        if (rendered.length < original.length) {
            let final = lines[lines.length - 1];
            while (final.length >= maxChars - 1) final = final.slice(0, -1);
            lines[lines.length - 1] = `${final.trimEnd()}…`;
        }
    }
    return lines.length ? lines : [''];
}

function buildOverlaySvg(width, height, text, inputDesign = {}) {
    const design = normalizeDesign(inputDesign);
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const fontSize = Math.max(18, safeWidth * design.fontSize / 100);
    const lineHeight = fontSize * 1.18;
    const margin = Math.max(18, Math.min(safeWidth, safeHeight) * 0.055);
    const maxChars = Math.max(12, Math.floor((safeWidth - margin * 2) / (fontSize * 0.58)));
    const lines = wrapText(text, maxChars, 3);
    const anchor = design.position.endsWith('left') ? 'start' : design.position.endsWith('right') ? 'end' : 'middle';
    const x = anchor === 'start' ? margin : anchor === 'end' ? safeWidth - margin : safeWidth / 2;
    const totalTextHeight = lineHeight * lines.length;
    let firstBaseline;
    if (design.position.startsWith('top-')) firstBaseline = margin + fontSize;
    else if (design.position.startsWith('bottom-')) firstBaseline = safeHeight - margin - totalTextHeight + fontSize;
    else firstBaseline = (safeHeight - totalTextHeight) / 2 + fontSize;

    const maxLineLength = Math.max(...lines.map(line => line.length), 1);
    const estimatedTextWidth = Math.min(safeWidth - margin * 2, Math.max(fontSize, maxLineLength * fontSize * 0.62));
    const paddingX = fontSize * 0.34;
    const paddingY = fontSize * 0.2;
    const panelWidth = Math.min(safeWidth - margin * 2, estimatedTextWidth + paddingX * 2);
    const panelX = anchor === 'start' ? x - paddingX : anchor === 'end' ? x - panelWidth + paddingX : (safeWidth - panelWidth) / 2;
    const panelY = firstBaseline - fontSize - paddingY;
    const panelHeight = totalTextHeight + paddingY * 2;
    const panel = design.panelEnabled
        ? `<rect x="${panelX.toFixed(1)}" y="${panelY.toFixed(1)}" width="${panelWidth.toFixed(1)}" height="${panelHeight.toFixed(1)}" rx="${(fontSize * 0.18).toFixed(1)}" fill="${design.panelColor}" fill-opacity="${design.panelOpacity}"/>`
        : '';
    const strokeWidth = (fontSize * design.outlineWidth / 100).toFixed(2);
    const textNodes = lines.map((line, index) => `<text x="${x.toFixed(1)}" y="${(firstBaseline + index * lineHeight).toFixed(1)}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="800" fill="${design.textColor}" stroke="${design.outlineColor}" stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke" style="paint-order:stroke">${xmlEscape(line)}</text>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">${panel}${textNodes}</svg>`;
}

async function generateChapterCoverBuffer(sourcePath, chapter, series, inputDesign = {}) {
    const sharp = require('sharp');
    const design = normalizeDesign(inputDesign);
    const source = await fs.readFile(sourcePath);
    if (!source.length) throw new Error('The selected cover image is empty.');
    if (source.length > 64 * 1024 * 1024) throw new Error('The selected cover image exceeds the 64 MiB safety limit.');

    const resized = await sharp(source, { failOn: 'error', limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: 4800, height: 7200, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
        .flatten({ background: '#ffffff' })
        .toBuffer({ resolveWithObject: true });
    const label = formatTemplate(design.template, chapter, series);
    const overlay = Buffer.from(buildOverlaySvg(resized.info.width, resized.info.height, label, design));
    return sharp(resized.data)
        .composite([{ input: overlay, blend: 'over' }])

        .webp({ lossless: true, effort: 6, smartSubsample: false })
        .toBuffer();
}

module.exports = {
    POSITIONS,
    normalizeDesign,
    normalizeKavitaAutoCoverDesign,
    formatTemplate,
    wrapText,
    buildOverlaySvg,
    generateChapterCoverBuffer
};
