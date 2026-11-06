'use strict';

const patternCache = new Map();

function naturalSortKey(value) {
    return String(value ?? '').normalize('NFKD').toLowerCase().replace(/\d+/g, digits => {
        const normalized = digits.replace(/^0+(?=\d)/, '');
        return `\u0001${String(normalized.length).padStart(8, '0')}:${normalized}\u0002`;
    });
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSearchPattern(pattern) {
    const source = String(pattern ?? '').slice(0, 200);
    if (patternCache.has(source)) return patternCache.get(source);
    const expression = [...source].map(character => character === '#' ? '[0-9]' : escapeRegExp(character)).join('');
    const compiled = new RegExp(expression, 'i');
    patternCache.set(source, compiled);
    if (patternCache.size > 64) patternCache.delete(patternCache.keys().next().value);
    return compiled;
}

function patternMatch(value, pattern) {
    if (value === null || value === undefined || pattern === null || pattern === undefined) return 0;
    try { return compileSearchPattern(pattern).test(String(value)) ? 1 : 0; }
    catch (_) { return 0; }
}

function pathSeriesName(filePath, rootPath) {
    if (filePath === null || filePath === undefined || rootPath === null || rootPath === undefined) return '';
    const normalize = value => {
        const normalized = String(value).replace(/\\/g, '/');
        return normalized === '/' ? '/' : normalized.replace(/\/+$/g, '');
    };
    const full = normalize(filePath);
    const root = normalize(rootPath);
    if (!full || !root || full.length <= root.length) return '';
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (!full.toLowerCase().startsWith(prefix.toLowerCase())) return '';
    const relative = full.slice(prefix.length);
    return relative.split('/')[0] || '';
}

function isLibrarySeriesFolderName(name) {
    const value = String(name ?? '').trim().toLowerCase();
    if (!value) return false;
    if (value === '.hist' || value.startsWith('.panelkeeper-')) return false;
    return true;
}

function registerSqliteTextFunctions(database) {
    database.function('pk_natural_key', naturalSortKey);
    database.function('pk_pattern_match', patternMatch);
    database.function('pk_path_series', pathSeriesName);
}

module.exports = { naturalSortKey, compileSearchPattern, patternMatch, pathSeriesName, isLibrarySeriesFolderName, registerSqliteTextFunctions };
