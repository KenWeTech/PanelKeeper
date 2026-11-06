'use strict';

function normalizeSeriesMatchTitle(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function findExactKavitaSeriesMatch(localSeriesName, kavitaSeries = []) {
    const expected = normalizeSeriesMatchTitle(localSeriesName);
    if (!expected) return { match: null, matches: [] };
    const unique = new Map();
    for (const row of Array.isArray(kavitaSeries) ? kavitaSeries : []) {
        const id = Number(row?.id ?? row?.seriesId);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const names = [row.name, row.originalName, row.localizedName].filter(Boolean);
        if (!names.some(name => normalizeSeriesMatchTitle(name) === expected)) continue;
        if (!unique.has(id)) unique.set(id, {
            id,
            name: String(row.name || row.originalName || row.localizedName || `Kavita series ${id}`),
            originalName: String(row.originalName || ''),
            localizedName: String(row.localizedName || ''),
            libraryName: String(row.libraryName || ''),
            chapterCount: Number(row.chapterCount || 0),
            volumeCount: Number(row.volumeCount || 0)
        });
    }
    const matches = [...unique.values()];
    return { match: matches.length === 1 ? matches[0] : null, matches };
}

module.exports = { normalizeSeriesMatchTitle, findExactKavitaSeriesMatch };
