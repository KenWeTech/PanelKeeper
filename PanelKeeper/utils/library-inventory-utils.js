'use strict';

function countDistinctRegularChapters(records, volumeMode = 'off') {
    const keys = new Set();
    const mode = String(volumeMode || 'off');
    if (mode === 'volume-only') return 0;

    for (const record of Array.isArray(records) ? records : []) {
        if (!record || !String(record.chapter_key || '').trim() || Number(record.is_special || 0) === 1 || Number(record.is_volume || 0) === 1) continue;
        if (record.chapter_number === null || record.chapter_number === undefined || record.chapter_number === '') continue;
        if (String(record.letter_suffix || '').trim()) continue;

        const number = Number(record.chapter_number);

        if (!Number.isFinite(number) || !Number.isInteger(number)) continue;

        const key = mode === 'volume-chapters'
            ? `${String(record.volume_key || '')}\u0000${number}`
            : String(number);
        keys.add(key);
    }
    return keys.size;
}

module.exports = { countDistinctRegularChapters };
