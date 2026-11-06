'use strict';

const { portableBasename } = require('./chapter-utils');

function buildComicInfoChapterContext(filePath, series = '', parsed = null) {
    const filename = portableBasename(String(filePath || ''));
    const cleanFilename = filename.replace(/\.(?:cbz|zip)$/i, '');
    const number = parsed && parsed.number != null
        ? `${parsed.number}${parsed.letterSuffix || ''}`
        : (parsed?.specialNumber != null ? String(parsed.specialNumber) : '');
    const title = String(parsed?.specialTitle || parsed?.additionalText || '').trim();
    const hasParsedIdentity = Boolean(parsed);
    const isSpecial = hasParsedIdentity ? Boolean(parsed.special) : null;
    const volume = parsed?.volumeNumber != null ? String(parsed.volumeNumber) : (parsed?.volumeLabel || '');
    return {
        Series: String(series || ''),
        SeriesName: String(series || ''),
        LocalizedSeries: '',
        ChapterNumber: parsed?.volumeOnly ? '' : number,
        Number: parsed?.volumeOnly ? '' : number,
        ChapterTitle: title,
        Title: title,
        ChapterLabel: String(parsed?.label || cleanFilename),
        Chapter: String(parsed?.label || cleanFilename),
        IsSpecial: isSpecial,
        Special: isSpecial,
        IsVolumeOnly: Boolean(parsed?.volumeOnly),
        Format: isSpecial === true ? 'Special' : '',
        SpecialNumber: parsed?.specialNumber == null ? '' : String(parsed.specialNumber),
        SpecialTitle: String(parsed?.specialTitle || ''),
        Volume: volume,
        LetterSuffix: String(parsed?.letterSuffix || ''),
        AdditionalText: String(parsed?.additionalText || ''),
        FileName: cleanFilename,
        FileNameWithExtension: filename
    };
}

module.exports = { buildComicInfoChapterContext };
