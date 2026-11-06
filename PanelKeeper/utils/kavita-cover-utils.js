'use strict';

function numericValue(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(6)) : null;
}

function normalizeNumber(value) {
    const number = numericValue(value);
    return number === null ? '' : String(number);
}

function volumeNumberFromValue(value) {
    const direct = numericValue(value);
    if (direct !== null) return direct;
    const text = String(value || '').trim();
    const match = text.match(/(?:^|\b)(?:volume|vol\.?|v\.?|tome|t\.?|巻|卷|册|권|เล่ม|том)\s*0*(\d+(?:\.\d+)?)/iu)
        || text.match(/^\s*0*(\d+(?:\.\d+)?)\s*(?:巻|卷|册|권|เล่ม)\s*$/iu)
        || text.match(/^\s*0*(\d+(?:\.\d+)?)\s*$/u);
    return match ? numericValue(match[1]) : null;
}

function getVolumeNumber(volume) {
    if (!volume) return null;
    return volumeNumberFromValue(volume.number) ?? volumeNumberFromValue(volume.name);
}

function buildVolumeLookup(volumes = []) {
    const lookup = new Map();
    for (const volume of Array.isArray(volumes) ? volumes : []) {
        const id = Number(volume?.id);
        const number = getVolumeNumber(volume);
        if (!Number.isSafeInteger(id) || id <= 0 || number === null) continue;
        lookup.set(String(id), number);
    }
    return lookup;
}

function normalizeTitle(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase()
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim().replace(/\s+/g, ' ');
}

function getSpecialNumber(chapter) {
    const values = [chapter?.number, chapter?.title, chapter?.titleName, chapter?.range];
    for (const value of values) {
        const match = String(value || '').match(/(?:^|\b)SP\s*0*(\d{1,4})(?:\b|$)/i);
        if (match) return Number(match[1]);
    }
    return numericValue(chapter?.minNumber);
}

function getChapterNumber(chapter) {
    return numericValue(chapter?.minNumber) ?? numericValue(chapter?.number);
}

function findKavitaCoverMatch(localChapter, kavitaChapters = [], kavitaVolumes = [], volumeMode = 'off') {
    if (!localChapter || !Array.isArray(kavitaChapters)) return { matched: false, reason: 'invalid_local_chapter' };
    const volumes = Array.isArray(kavitaVolumes) ? kavitaVolumes : [];

    if (localChapter.isVolume || localChapter.volumeOnly) {
        const targetVolume = numericValue(localChapter.volumeNumber) ?? volumeNumberFromValue(localChapter.volumeKey);
        const volumeEnd = numericValue(localChapter.volumeEndNumber);
        if (targetVolume === null) return { matched: false, reason: 'volume_number_unavailable' };
        if (volumeEnd !== null && volumeEnd !== targetVolume) return { matched: false, reason: 'volume_range_not_unique' };
        const candidates = volumes.filter(volume => getVolumeNumber(volume) === targetVolume && Number.isSafeInteger(Number(volume.id)) && Number(volume.id) > 0);
        if (candidates.length !== 1) return { matched: false, reason: candidates.length ? 'ambiguous_volume' : 'volume_not_found' };
        return { matched: true, kind: 'volume', id: Number(candidates[0].id), volume: candidates[0] };
    }

    if (localChapter.special) {
        const specials = kavitaChapters.filter(chapter => chapter?.isSpecial === true && Number.isSafeInteger(Number(chapter.id)) && Number(chapter.id) > 0);
        const specialNumber = numericValue(localChapter.specialNumber);
        let candidates = [];
        if (specialNumber !== null) {
            candidates = specials.filter(chapter => getSpecialNumber(chapter) === specialNumber);
        }
        if (candidates.length !== 1 && localChapter.specialTitle) {
            const expected = normalizeTitle(localChapter.specialTitle);
            if (expected) candidates = specials.filter(chapter => [chapter.title, chapter.titleName, chapter.number, chapter.range]
                .some(value => normalizeTitle(value) === expected));
        }
        if (candidates.length !== 1) return { matched: false, reason: candidates.length ? 'ambiguous_special' : 'special_not_found' };
        return { matched: true, kind: 'chapter', id: Number(candidates[0].id), chapter: candidates[0] };
    }

    const targetNumber = numericValue(localChapter.number);
    if (targetNumber === null) return { matched: false, reason: 'chapter_number_unavailable' };
    let candidates = kavitaChapters.filter(chapter => chapter?.isSpecial !== true
        && Number.isSafeInteger(Number(chapter.id)) && Number(chapter.id) > 0
        && getChapterNumber(chapter) === targetNumber);

    if (volumeMode === 'volume-chapters' && localChapter.volumeKey) {
        const targetVolume = numericValue(localChapter.volumeNumber) ?? volumeNumberFromValue(localChapter.volumeKey);
        const volumeEnd = numericValue(localChapter.volumeEndNumber);
        if (targetVolume === null) return { matched: false, reason: 'volume_number_unavailable' };
        if (volumeEnd !== null && volumeEnd !== targetVolume) return { matched: false, reason: 'volume_range_not_unique' };
        const volumeLookup = buildVolumeLookup(volumes);
        candidates = candidates.filter(chapter => volumeLookup.get(String(chapter.volumeId)) === targetVolume);
    }

    if (candidates.length !== 1) return { matched: false, reason: candidates.length ? 'ambiguous_chapter' : 'chapter_not_found' };
    return { matched: true, kind: 'chapter', id: Number(candidates[0].id), chapter: candidates[0] };
}

module.exports = {
    numericValue,
    volumeNumberFromValue,
    getVolumeNumber,
    buildVolumeLookup,
    normalizeTitle,
    findKavitaCoverMatch
};
