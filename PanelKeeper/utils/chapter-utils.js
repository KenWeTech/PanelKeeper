'use strict';

const path = require('path');

function portableBasename(value) {

    const text = String(value || '').replace(/\\_/g, '_').replace(/[\\/]+$/, '');
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || path.basename(text);
}

function canonicalChapterNumberText(numberText) {
    const match = String(numberText ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return '';
    const whole = String(Number(match[1]));

    return match[2] === undefined ? whole : `${whole}.${match[2]}`;
}

function formatChapterNumber(numberText) {
    const canonical = canonicalChapterNumberText(numberText);
    if (!canonical) return '';
    const [whole, fraction] = canonical.split('.');
    const paddedWhole = Number(whole) < 10 ? `0${whole}` : whole;
    return fraction === undefined ? paddedWhole : `${paddedWhole}.${fraction}`;
}

function stripTranslatorCredits(value) {
    return String(value || '')
        .replace(/\s*[\[(]\s*(?:translated|translation|translator|scanlated|scanlation|typeset|proofread|edited|lettered|redrawn|redraw|cleaned)\s+by\b[^\])]*[\])]/ig, ' ')
        .replace(/\s*[\[(]\s*(?:translation|translator|scanlation|scanlator)\s*[:=]\s*[^\])]*[\])]/ig, ' ')
        .replace(/\s*(?:[-–—:_]\s*)?(?:translated|translation|translator|scanlated|scanlation|typeset|proofread|edited|lettered|redrawn|redraw|cleaned)\s+by\b.*$/ig, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeIgnoredTerms(terms) {
    const values = Array.isArray(terms)
        ? terms
        : (typeof terms === 'string' ? terms.split(/\r?\n/) : []);
    const seen = new Set();
    const normalized = [];
    for (const value of values) {
        const term = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        const key = term.toLocaleLowerCase();
        if (!term || seen.has(key)) continue;
        seen.add(key);
        normalized.push(term);
        if (normalized.length >= 100) break;
    }
    return normalized;
}

function mergeIgnoredTerms(globalTerms = [], seriesTerms = []) {

    return normalizeIgnoredTerms([...normalizeIgnoredTerms(globalTerms), ...normalizeIgnoredTerms(seriesTerms)]);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripIgnoredChapterTerms(value, ignoredTerms = []) {
    let result = String(value || '');
    for (const term of normalizeIgnoredTerms(ignoredTerms)) {

        const pattern = term.split(/\s+/).map(escapeRegExp).join('\\s+');
        const expression = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu');
        result = result.replace(expression, ' ');
    }
    return result
        .replace(/[\[(]\s*[\])]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasIgnoredChapterTerms(value, ignoredTerms = []) {
    const raw = String(value || '');
    return stripIgnoredChapterTerms(raw, ignoredTerms) !== raw.replace(/\s+/g, ' ').trim();
}

function cleanChapterTitle(tail) {
    let value = stripTranslatorCredits(tail);

    value = value.replace(/\s*\(\d{1,6}\)\s*$/i, ' ');
    value = value.replace(/[\s._-]*v\d+\s*$/i, ' ');

    value = value.replace(/^[\s._:]+/, '').replace(/_/g, ' ');
    value = value.replace(/\((?:v\d+|colored|colour|official|digital|webtoon|uncensored|remastered|complete)\)/ig, ' ');
    value = value.replace(/\s+/g, ' ').trim();
    if (!value || /^v\d+$/i.test(value) || /^\(?v\d+\)?$/i.test(value)) return '';
    return cleanAdditionalChapterText(value);
}

function parseChapterBase(filename, seriesName = '', options = {}) {
    let stem = portableBasename(filename).replace(/\.(?:cbz|zip)$/i, '').trim();
    if (seriesName) stem = stem.replace(new RegExp(String(seriesName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
    stem = stripIgnoredChapterTerms(stem, options?.ignoredTerms);
    stem = stripTranslatorCredits(stem)
        .replace(/\[[^\]]*(?:scan|digital|web|rip|group)[^\]]*\]/ig, ' ')
        .replace(/\((?:colored|colour|official|digital|webtoon|uncensored|remastered|complete|v\d+)\)/ig, ' ')
        .replace(/\s+/g, ' ').trim();

    const kavitaSpecial = stem.match(/\bSP(\d{1,4})\b/i);
    if (kavitaSpecial) {
        const specialNumber = Number(kavitaSpecial[1]);
        const before = stem.slice(0, kavitaSpecial.index);
        const after = stem.slice(kavitaSpecial.index + kavitaSpecial[0].length);
        let specialTitle = cleanChapterTitle(`${before} ${after}`)
            .replace(/^[-–—: ]+/, '')
            .replace(/^(?:special|extra|ova)\s+/i, '')
            .trim();
        const displayNumber = String(specialNumber).padStart(2, '0');
        const label = specialTitle ? `Special ${displayNumber} - ${specialTitle}` : `Special ${displayNumber}`;
        return {
            label,
            key: `special:${specialNumber}`,
            number: specialNumber,
            specialNumber,
            specialTitle,
            additionalText: specialTitle,
            special: true
        };
    }

    const rawSpecialMatch = stem.match(/\b(?:special|extra|ova|oneshot|one[- ]shot|side story)\b/i);

    const explicitChapterMarker = /\b(?:chapter|chap|chp|ch|c|episode|ep|話|话|화|회|บทที่|ตอนที่|глава)\s*\.?\s*(?:#\s*)?\d/i.exec(stem);
    const postfixChapterMarker = /(?:第\s*)?\d+(?:\.\d+)?[a-z]?\s*(?:話|话|화|회)(?![\p{L}\p{N}])/iu.exec(stem);
    const bareNumberMarker = /(?:^|[^\d])(\d{1,7}(?:\.\d+)?)([a-z])?(?![a-z0-9])/i.exec(stem);
    const chapterIdentityIndex = explicitChapterMarker?.index ?? postfixChapterMarker?.index ?? (bareNumberMarker ? bareNumberMarker.index + bareNumberMarker[0].search(/\d/) : Number.POSITIVE_INFINITY);
    const specialMatch = rawSpecialMatch && rawSpecialMatch.index < chapterIdentityIndex ? rawSpecialMatch : null;
    const hasExplicitChapterNumber = Boolean(explicitChapterMarker || postfixChapterMarker);
    if (specialMatch && !hasExplicitChapterNumber) {
        const afterSpecial = stem.slice(specialMatch.index + specialMatch[0].length);
        const immediateSpecialNumber = afterSpecial.match(/^\s*(?:[-–—:]\s*)?(\d+(?:\.\d+)?)([a-z])?(?=$|[\s._:-])([\s\S]*)/i);
        const marker = specialMatch[0].toLowerCase().replace(/\s+/g, ' ');
        const prefix = marker === 'one shot' || marker === 'oneshot' ? 'One-Shot'
            : marker === 'side story' ? 'Side Story'
            : marker === 'ova' ? 'OVA'
            : marker.charAt(0).toUpperCase() + marker.slice(1);
        if (immediateSpecialNumber) {
            const numberText = canonicalChapterNumberText(immediateSpecialNumber[1]);
            const numeric = Number(numberText);
            const suffix = String(immediateSpecialNumber[2] || '').toLowerCase();
            const additionalText = cleanChapterTitle(immediateSpecialNumber[3] || '');
            const display = `${formatChapterNumber(numberText)}${suffix}`;
            const label = additionalText ? `${prefix} ${display} - ${additionalText}` : `${prefix} ${display}`;
            return {
                label, key: `special:${numberText}${suffix}`, number: numeric, numberText,
                specialNumber: Number.isInteger(numeric) && numeric > 0 ? numeric : null,
                specialTitle: additionalText, letterSuffix: suffix, additionalText, special: true
            };
        }
        const specialText = cleanChapterTitle(`${stem.slice(0, specialMatch.index)} ${afterSpecial}`);
        const label = specialText ? `${prefix} ${specialText}` : prefix;
        return {
            label,
            key: `special:${slugChapterText(specialText || prefix)}`,
            number: null,
            specialNumber: null,
            specialTitle: specialText,
            additionalText: specialText,
            special: true
        };
    }

    const underscoreLabelled = stem.match(/\b(?:chapter|chap|chp|ch|c|episode|ep|話|话|화|회|บทที่|ตอนที่|глава)\s*\.?\s*(?:#\s*)?(\d+(?:\.\d+)?)([a-z])?(?:\\)?_+\s*([\s\S]+)$/i);

    const postfixChapterLabelled = stem.match(/(?:第\s*)?(\d+(?:\.\d+)?)([a-z])?\s*(?:話|话|화|회)(?![\p{L}\p{N}])([\s\S]*)/iu);

    const hyphenSubchapter = stem.match(/\b(?:chapter|chap|chp|ch|c|episode|ep|話|话|화|회|บทที่|ตอนที่|глава)\s*\.?\s*(?:#\s*)?(\d+)\s*-\s*(\d+)([a-z])?(?![a-z0-9])([\s\S]*)/i);
    const labelled = [...stem.matchAll(/\b(?:chapter|chap|chp|ch|c|episode|ep|話|话|화|회|บทที่|ตอนที่|глава)\s*\.?\s*(?:#\s*)?(\d+(?:\.\d+)?)([a-z])?(?![a-z0-9])([\s\S]*)/ig)];

    let numberText = '';
    let letterSuffix = '';
    let tail = '';
    if (underscoreLabelled) {
        numberText = underscoreLabelled[1];
        letterSuffix = String(underscoreLabelled[2] || '').toLowerCase();
        tail = underscoreLabelled[3] || '';
    } else if (postfixChapterLabelled) {
        numberText = postfixChapterLabelled[1];
        letterSuffix = String(postfixChapterLabelled[2] || '').toLowerCase();
        tail = postfixChapterLabelled[3] || '';
    } else if (hyphenSubchapter) {
        numberText = `${hyphenSubchapter[1]}.${hyphenSubchapter[2]}`;
        letterSuffix = String(hyphenSubchapter[3] || '').toLowerCase();
        tail = hyphenSubchapter[4] || '';
    } else if (labelled.length) {
        const match = labelled[labelled.length - 1];
        numberText = match[1];
        letterSuffix = String(match[2] || '').toLowerCase();
        tail = match[3] || '';
    }

    if (!numberText) {

        const fallbackStem = stem
            .replace(/\s*\(\d{1,6}\)\s*$/i, '')
            .replace(/[\s._-]*v\d+\s*$/i, '')
            .trim();
        const numbers = [...fallbackStem.matchAll(/(?:^|[^\d])((?:\d{1,7})(?:\.\d+)?)([a-z])?(?![a-z0-9])([\s\S]*)/gi)];
        if (numbers.length) {
            const match = numbers[numbers.length - 1];
            numberText = match[1];
            letterSuffix = String(match[2] || '').toLowerCase();
            tail = match[3] || '';
        }
    }

    if (!numberText && specialMatch) {
        const marker = specialMatch[0].toLowerCase().replace(/\s+/g, ' ');
        const prefix = marker === 'one shot' || marker === 'oneshot' ? 'One-Shot'
            : marker === 'side story' ? 'Side Story'
            : marker === 'ova' ? 'OVA'
            : marker.charAt(0).toUpperCase() + marker.slice(1);
        const specialText = cleanChapterTitle(stem.replace(specialMatch[0], ' '));
        const label = specialText ? `${prefix} ${specialText}` : prefix;
        return {
            label,
            key: `special:${slugChapterText(specialText || prefix)}`,
            number: null,
            specialNumber: null,
            specialTitle: specialText,
            additionalText: specialText,
            special: true
        };
    }
    if (!numberText) return null;

    const canonicalNumberText = canonicalChapterNumberText(numberText);
    const numeric = Number(canonicalNumberText);
    if (!canonicalNumberText || !Number.isFinite(numeric)) return null;
    const formatted = formatChapterNumber(canonicalNumberText);
    const displayNumber = `${formatted}${letterSuffix}`;
    const additionalText = cleanChapterTitle(tail);
    const labelPrefix = specialMatch ? `Special ${displayNumber}` : `Chapter ${displayNumber}`;
    const label = additionalText ? `${labelPrefix} - ${additionalText}` : labelPrefix;
    return {
        label,
        key: `${specialMatch ? 'special' : 'chapter'}:${canonicalNumberText}${letterSuffix}`,
        number: numeric,
        numberText: canonicalNumberText,
        letterSuffix,
        specialNumber: specialMatch ? (Number.isInteger(numeric) && numeric > 0 ? numeric : null) : null,
        specialTitle: specialMatch ? additionalText : '',
        special: Boolean(specialMatch),
        additionalText
    };
}

function formatVolumeNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value || '').trim();
    if (Number.isInteger(number)) return String(number).padStart(2, '0');
    const [whole, fraction] = String(number).split('.');
    return `${String(Number(whole)).padStart(2, '0')}.${fraction || ''}`;
}

function removeSeriesFromStem(stem, seriesName) {
    if (!seriesName) return stem;
    const escaped = String(seriesName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return stem.replace(new RegExp(escaped, 'ig'), ' ');
}

function findVolumeMarker(stem) {
    const text = String(stem || '');
    const candidates = [];
    const chapterMarker = text.search(/(?:\b(?:chapter|chap|chp|ch|c|episode|ep)\s*\.?\s*(?:#\s*)?\d|(?:第\s*)?\d+(?:\.\d+)?\s*(?:話|话|화|회)|(?:제\s*)?\d+(?:화|회)|(?:บทที่|ตอนที่)\s*\d|глава\s*\d)/iu);

    const addMatches = (regex, startGroup = 1, endGroup = 2) => {
        for (const match of text.matchAll(regex)) {
            const first = Number(match[startGroup]);
            const last = endGroup && match[endGroup] ? Number(match[endGroup]) : first;
            if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
            const start = Math.min(first, last);
            const end = Math.max(first, last);
            const range = Math.abs(end - start) > 0.0000001;
            const key = range ? `${String(start)}-${String(end)}` : String(start);
            const label = range
                ? `Volume ${formatVolumeNumber(start)}-${formatVolumeNumber(end)}`
                : `Volume ${formatVolumeNumber(start)}`;
            candidates.push({
                index: match.index,
                length: match[0].length,
                number: start,
                endNumber: range ? end : start,
                key,
                label,
                raw: match[0],
                kind: 'explicit'
            });
        }
    };

    addMatches(/\b(?:volume|vol)\.?\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(?:(?:volume|vol)\.?\s*)?(\d+(?:\.\d+)?))?/giu);
    addMatches(/\b(?:tome|t)\.?\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(?:(?:tome|t)\.?\s*)?(\d+(?:\.\d+)?))?/giu);

    addMatches(/\bS(\d{1,4})(?![a-z0-9])/giu, 1, null);

    addMatches(/(?:卷|册)\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?/gu);
    addMatches(/(\d+(?:\.\d+)?)\s*巻(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?/gu);
    addMatches(/(?:권|장|시즌)\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?/gu);
    addMatches(/(?:เล่มที่|เล่ม)\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?/gu);
    addMatches(/(?:Том|Тома)\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(\d+(?:\.\d+)?))?/giu);

    for (const match of text.matchAll(/(?:^|[\s._([{])((?:v)\.?\s*\d+(?:\.\d+)?(?:\s*[-–—]\s*(?:v\.?\s*)?\d+(?:\.\d+)?)?)(?=$|[\s._)\]}])/giu)) {
        const marker = match[1];
        const index = match.index + match[0].indexOf(marker);
        const endIndex = index + marker.length;
        const prefixChar = text[index - 1] || '';
        const suffixChar = text[endIndex] || '';
        const wrapped = (prefixChar === '(' && suffixChar === ')') || (prefixChar === '[' && suffixChar === ']');
        if (chapterMarker >= 0 && index > chapterMarker && !wrapped) continue;
        const before = text.slice(0, index);
        const after = text.slice(endIndex);
        const numericDashSuffix = /\b\d+(?:\.\d+)?\s*[-–—]\s*$/.test(before)
            && !/(?:\b(?:chapter|chap|chp|ch|c|episode|ep)\s*\.?\s*\d|(?:第\s*)?\d+(?:\.\d+)?\s*(?:話|话|화|회)|(?:제\s*)?\d+(?:화|회)|(?:บทที่|ตอนที่)\s*\d|глава\s*\d)/iu.test(after);
        if (numericDashSuffix && !wrapped) continue;
        const numberMatch = marker.match(/^v\.?\s*(\d+(?:\.\d+)?)(?:\s*[-–—]\s*(?:v\.?\s*)?(\d+(?:\.\d+)?))?$/iu);
        if (!numberMatch) continue;
        const first = Number(numberMatch[1]);
        const last = Number(numberMatch[2] || numberMatch[1]);
        if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
        const start = Math.min(first, last);
        const end = Math.max(first, last);
        const range = Math.abs(end - start) > 0.0000001;
        const key = range ? `${String(start)}-${String(end)}` : String(start);
        candidates.push({
            index,
            length: marker.length,
            number: start,
            endNumber: range ? end : start,
            key,
            label: range
                ? `Volume ${formatVolumeNumber(start)}-${formatVolumeNumber(end)}`
                : `Volume ${formatVolumeNumber(start)}`,
            raw: marker,
            kind: 'v'
        });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => a.index - b.index || (a.kind === 'v' ? 1 : -1));
    return candidates[0];
}

function parseChapter(filename, seriesName = '', options = {}) {
    const volumeMode = ['volume-chapters', 'volume-only'].includes(String(options?.volumeMode || 'off'))
        ? String(options.volumeMode)
        : 'off';
    if (volumeMode === 'off') return parseChapterBase(filename, seriesName, options);

    const rawName = portableBasename(filename);
    const extension = path.extname(rawName);
    let stem = extension ? rawName.slice(0, -extension.length) : rawName;
    stem = removeSeriesFromStem(stem, seriesName).replace(/\s+/g, ' ').trim();
    const volume = findVolumeMarker(stem);

    const special = parseChapterBase(filename, seriesName, options);
    if (special?.special) return special;
    if (!volume) {
        return volumeMode === 'volume-only' ? null : parseChapterBase(filename, seriesName, options);
    }

    if (volumeMode === 'volume-only') {
        return {
            label: volume.label,
            key: `volume:${volume.key}`,
            number: null,
            letterSuffix: '',
            specialNumber: null,
            specialTitle: '',
            special: false,
            additionalText: '',
            volumeKey: volume.key,
            volumeLabel: volume.label,
            volumeNumber: volume.number,
            volumeEndNumber: volume.endNumber,
            isVolume: true,
            volumeOnly: true
        };
    }

    const withoutMarker = `${stem.slice(0, volume.index)} ${stem.slice(volume.index + volume.length)}${extension}`
        .replace(/[[(]\s*[)\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const chapter = parseChapterBase(withoutMarker, seriesName, options);
    if (!chapter) {
        return {
            label: volume.label,
            key: `volume:${volume.key}`,
            number: null,
            letterSuffix: '',
            specialNumber: null,
            specialTitle: '',
            special: false,
            additionalText: '',
            volumeKey: volume.key,
            volumeLabel: volume.label,
            volumeNumber: volume.number,
            volumeEndNumber: volume.endNumber,
            isVolume: true,
            volumeOnly: true
        };
    }
    if (chapter.special) return chapter;
    return {
        ...chapter,
        key: `volume:${volume.key}|${chapter.key}`,
        volumeKey: volume.key,
        volumeLabel: volume.label,
        volumeNumber: volume.number,
        volumeEndNumber: volume.endNumber,
        isVolume: false,
        volumeOnly: false
    };
}

function extractChapterInfo(filename, seriesName, options = {}) {
    return parseChapter(filename, seriesName, options)?.label || null;
}

function extractDownloaderCopyNumber(filename) {
    const stem = portableBasename(filename).replace(/\.(?:cbz|zip)$/i, '').trim();

    const match = stem.match(/\((\d{1,6})\)\s*$/);
    return match ? Number(match[1]) : null;
}

function rankDownloaderCopies(entries) {
    return [...entries].sort((a, b) =>
        (b.copyNumber ?? -1) - (a.copyNumber ?? -1) ||
        (b.mtime || 0) - (a.mtime || 0) ||
        String(b.name || '').localeCompare(String(a.name || ''), undefined, { numeric: true, sensitivity: 'base' })
    );
}

function cleanAdditionalChapterText(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/[<>:"/\\|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[-–—: ]+|[-–—: ]+$/g, '')
        .replace(/[. ]+$/g, '')
        .slice(0, 120);
}

function slugChapterText(value) {
    return String(value || '').toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'untitled';
}

function parseChapterLabel(input, options = {}) {
    const text = stripTranslatorCredits(stripIgnoredChapterTerms(String(input || ''), options?.ignoredTerms)).replace(/\s+/g, ' ');
    if (!text || text.length > 180) return null;
    if (['volume-chapters', 'volume-only'].includes(String(options?.volumeMode || 'off'))) {
        const volumeParsed = parseChapter(`${text}.cbz`, '', options);
        if (volumeParsed) return volumeParsed;
    }

    const kavitaMarker = text.match(/^SP(\d{1,4})(?:\s*[-–—:_]?\s*(.*))?$/i);
    if (kavitaMarker) {
        const number = Number(kavitaMarker[1]);
        if (!Number.isInteger(number) || number < 1) return null;
        const descriptor = cleanChapterTitle(kavitaMarker[2]);
        const base = `Special ${String(number).padStart(2, '0')}`;
        const label = descriptor ? `${base} - ${descriptor}` : base;
        return { label, key: `special:${number}`, number, specialNumber: number, specialTitle: descriptor, special: true };
    }

    const special = text.match(/^(special|extra|ova|one[- ]shot|side story)(?:\s*[-:–—]?\s*(.*))?$/i);
    if (special) {
        const rawPrefix = special[1].toLowerCase().replace(/\s+/g, ' ');
        const prefix = rawPrefix === 'one shot' || rawPrefix === 'one-shot'
            ? 'One-Shot'
            : rawPrefix === 'side story' ? 'Side Story'
            : rawPrefix.toUpperCase() === 'OVA' ? 'OVA'
            : rawPrefix.charAt(0).toUpperCase() + rawPrefix.slice(1);
        const descriptor = cleanChapterTitle(special[2]);
        if (!special[2] || !special[2].trim()) {
            return { label: prefix, key: `special:${slugChapterText(prefix)}`, number: null, special: true };
        }
        const numbered = descriptor.match(/^(\d+(?:\.\d+)?)([a-z])?(?:\s*[-–—:]?\s*(.*))?$/i);
        if (numbered) {
            const numberText = canonicalChapterNumberText(numbered[1]);
            const number = Number(numberText);
            if (!numberText || !Number.isFinite(number)) return null;
            const suffix = String(numbered[2] || '').toLowerCase();
            const extra = cleanChapterTitle(numbered[3]);
            const base = `${prefix} ${formatChapterNumber(numberText)}${suffix}`;
            const label = extra ? `${base} - ${extra}` : base;
            return { label, key: `special:${numberText}${suffix}`, number, numberText, specialNumber: Number.isInteger(number) && number > 0 ? number : null, specialTitle: extra, letterSuffix: suffix, special: true };
        }
        if (!descriptor) return null;
        const label = `${prefix} ${descriptor}`;
        return { label, key: `special:${slugChapterText(descriptor)}`, number: null, specialNumber: null, specialTitle: descriptor, additionalText: descriptor, special: true };
    }

    const postfixChapter = text.match(/^(?:第\s*)?(\d+(?:\.\d+)?)([a-z])?\s*(?:話|话|화|회)(?:\s*[-–—:_]?\s*([\s\S]*))?$/iu);
    if (postfixChapter) {
        const numberText = canonicalChapterNumberText(postfixChapter[1]);
        const number = Number(numberText);
        if (!numberText || !Number.isFinite(number)) return null;
        const suffix = String(postfixChapter[2] || '').toLowerCase();
        const additional = cleanChapterTitle(postfixChapter[3]);
        const base = `Chapter ${formatChapterNumber(postfixChapter[1])}${suffix}`;
        const label = additional ? `${base} - ${additional}` : base;
        return { label, key: `chapter:${numberText}${suffix}`, number, numberText, letterSuffix: suffix, special: false, additionalText: additional || '' };
    }
    const chapter = text.match(/^(?:(?:chapter|chap|chp|ch|c|episode|ep|話|话|화|회|บทที่|ตอนที่|глава)\s*\.?\s*)?(\d+(?:\.\d+)?)([a-z])?(?:\s*(?:[-–—:_]\s*|\s+)([\s\S]*))?$/i);
    if (!chapter) return null;
    const numberText = canonicalChapterNumberText(chapter[1]);
    const number = Number(numberText);
    if (!numberText || !Number.isFinite(number)) return null;
    const suffix = String(chapter[2] || '').toLowerCase();
    let additional = cleanChapterTitle(chapter[3]);
    if (/^v\d+$/i.test(additional)) additional = '';
    const base = `Chapter ${formatChapterNumber(chapter[1])}${suffix}`;
    const label = additional ? `${base} - ${additional}` : base;
    return { label, key: `chapter:${numberText}${suffix}`, number, numberText, letterSuffix: suffix, special: false, additionalText: additional || '' };
}

module.exports = {
    formatChapterNumber,
    canonicalChapterNumberText,
    formatVolumeNumber,
    findVolumeMarker,
    parseChapter,
    extractChapterInfo,
    extractDownloaderCopyNumber,
    rankDownloaderCopies,
    parseChapterLabel,
    stripTranslatorCredits,
    normalizeIgnoredTerms,
    mergeIgnoredTerms,
    stripIgnoredChapterTerms,
    hasIgnoredChapterTerms,
    cleanChapterTitle,
    portableBasename
};
