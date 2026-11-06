'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const qcDb = require('./qc-database');
const zip = require('./utils/zip-utils');
const { parseChapter, extractChapterInfo, extractDownloaderCopyNumber, rankDownloaderCopies, parseChapterLabel, portableBasename, normalizeIgnoredTerms, mergeIgnoredTerms, hasIgnoredChapterTerms } = require('./utils/chapter-utils');
const { isLibrarySeriesFolderName } = require('./utils/text-utils');
const chapterCoverGenerator = require('./chapter-cover-generator');
const libraryMergeUtils = require('./utils/library-merge-utils');
const { findExactKavitaSeriesMatch } = require('./utils/kavita-match-utils');
const coverImportUtils = require('./utils/cover-import-utils');
const webhookErrorUtils = require('./utils/webhook-error-utils');
const notificationUtils = require('./utils/notification-utils');
const completedSeriesUtils = require('./utils/completed-series-utils');
const libraryInventoryUtils = require('./utils/library-inventory-utils');
const comicInfoUtils = require('./utils/comicinfo-utils');
const { buildComicInfoChapterContext } = require('./utils/comicinfo-context-utils');
const { sanitizeSpecialQcIssue } = require('./utils/qc-special-utils');
const sharp = require('sharp');

const APP_DIR = __dirname;
const QC_ANALYSIS_VERSION = 12;
const LOG_PATH = path.join(APP_DIR, 'manager_history.log');
const DEFAULT_LOG_RETENTION = 5000;
const DEFAULT_LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;
let logInsertCount = 0;
let pipelinePromise = null;
let pipelineGeneration = 0;
let activeQcJob = null;
let activeQcMutations = 0;
const qcMutationWaiters = [];
let activeCoverMutations = 0;
const coverMutationWaiters = [];
let coverWorkerRunning = false;
let chapterCoverWorkerRunning = false;
let kavitaAutoCoverBulkWorkerRunning = false;
const qcJobHistory = new Map();
let conflictReconcileCursor = 0;
let queuedChapterReconcilePromise = null;
let queuedChapterReconcileComplete = false;
let queuedChapterReconcileResult = null;
let activeLibraryCatalogJobId = null;
let libraryCatalogWorkerRunning = false;
let activeLibraryCatalogSeries = '';
const touchedLibrarySeries = new Set();

function nowLocal() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function getSetting(key, fallback = '') {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
}

const VALID_VOLUME_MODES = new Set(['off', 'volume-chapters', 'volume-only']);
const seriesVolumeModeCache = new Map();
const seriesIgnoredTermsCache = new Map();
let globalIgnoredTermsCache = null;
const GLOBAL_IGNORED_TERMS_SETTING = 'globalIgnoredChapterTerms';

function volumeModeCacheKey(series) { return String(series || '').trim().toLocaleLowerCase(); }

function getSeriesVolumeMode(series) {
    const cacheKey = volumeModeCacheKey(series);
    if (!cacheKey) return 'off';
    if (seriesVolumeModeCache.has(cacheKey)) return seriesVolumeModeCache.get(cacheKey);
    const row = db.prepare('SELECT volume_mode FROM series_volume_settings WHERE lower(series)=lower(?)').get(String(series));

    const storedMode = row?.volume_mode;
    const mode = VALID_VOLUME_MODES.has(storedMode) ? storedMode : 'off';
    seriesVolumeModeCache.set(cacheKey, mode);
    return mode;
}

function setSeriesVolumeMode(series, mode) {
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    const normalized = String(mode || 'off');
    if (!VALID_VOLUME_MODES.has(normalized)) throw new Error('Choose Off, Volumes + Chapters, or Whole Volumes.');
    const now = new Date().toISOString();
    if (normalized === 'off') {
        db.prepare('DELETE FROM series_volume_settings WHERE lower(series)=lower(?)').run(validation.value);
    } else {
        db.prepare(`INSERT INTO series_volume_settings (series, volume_mode, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(series) DO UPDATE SET volume_mode=excluded.volume_mode, updated_at=excluded.updated_at`)
            .run(validation.value, normalized, now);
    }
    seriesVolumeModeCache.set(volumeModeCacheKey(validation.value), normalized);

    const { destRoot } = getRoots();
    const seriesPath = destRoot ? path.resolve(destRoot, validation.value) : '';
    if (destRoot && isWithin(destRoot, seriesPath) && !samePath(destRoot, seriesPath)) {
        const prefix = path.join(seriesPath, '');
        qcDb.prepare('DELETE FROM qc_cache WHERE substr(path, 1, length(?)) = ? COLLATE NOCASE').run(prefix, prefix);
    }
    db.prepare('UPDATE library_series_state SET last_scanned_at=NULL, updated_at=? WHERE lower(series)=lower(?)')
        .run(now, validation.value);
    log(`Volume parsing mode for "${validation.value}" changed to ${normalized}; its QC and inventory analysis will be refreshed.`);
    return normalized;
}

function renameSeriesVolumeMode(oldName, newName) {
    const oldKey = volumeModeCacheKey(oldName);
    const newKey = volumeModeCacheKey(newName);
    const existing = db.prepare('SELECT volume_mode FROM series_volume_settings WHERE lower(series)=lower(?)').get(String(oldName));
    const target = db.prepare('SELECT 1 FROM series_volume_settings WHERE lower(series)=lower(?)').get(String(newName));
    if (existing && !target) {
        db.prepare('UPDATE series_volume_settings SET series=?, updated_at=? WHERE lower(series)=lower(?)')
            .run(String(newName), new Date().toISOString(), String(oldName));
        seriesVolumeModeCache.set(newKey, existing.volume_mode);
    } else if (target) {

        db.prepare('DELETE FROM series_volume_settings WHERE lower(series)=lower(?)').run(String(oldName));
        seriesVolumeModeCache.delete(newKey);
    } else {
        seriesVolumeModeCache.set(newKey, 'off');
    }
    seriesVolumeModeCache.delete(oldKey);
}

function getGlobalIgnoredTerms() {
    if (globalIgnoredTermsCache !== null) return [...globalIgnoredTermsCache];
    const raw = getSetting(GLOBAL_IGNORED_TERMS_SETTING, '[]');
    try {
        const parsed = JSON.parse(raw || '[]');
        globalIgnoredTermsCache = normalizeIgnoredTerms(parsed);
    } catch (_) {
        globalIgnoredTermsCache = normalizeIgnoredTerms(raw || '');
    }
    return [...globalIgnoredTermsCache];
}

function getSeriesIgnoredTerms(series) {
    const cacheKey = volumeModeCacheKey(series);
    if (!cacheKey) return [];
    if (seriesIgnoredTermsCache.has(cacheKey)) return [...seriesIgnoredTermsCache.get(cacheKey)];
    const row = db.prepare('SELECT terms_json FROM series_ignored_terms WHERE lower(series)=lower(?)').get(String(series));
    let terms = [];
    try { terms = normalizeIgnoredTerms(JSON.parse(row?.terms_json || '[]')); } catch (_) { terms = []; }
    seriesIgnoredTermsCache.set(cacheKey, terms);
    return [...terms];
}

function getEffectiveIgnoredTerms(series) {

    return mergeIgnoredTerms(getGlobalIgnoredTerms(), getSeriesIgnoredTerms(series));
}

function setGlobalIgnoredTerms(inputTerms) {
    if (activeQcJob && activeQcJob.status === 'running') {
        throw new Error('Global ignore rules cannot be changed while a QC scan is running. Let the scan finish, then save the rules and start a fresh full QC scan.');
    }
    if (!Array.isArray(inputTerms) && typeof inputTerms !== 'string') {
        throw new Error('Global ignored chapter terms must be a list of words or phrases.');
    }
    const terms = normalizeIgnoredTerms(inputTerms);
    const previous = getGlobalIgnoredTerms();
    if (JSON.stringify(previous) === JSON.stringify(terms)) {
        return { terms, changed: false, qcFilesMarkedForRecheck: 0, invalidatedDismissals: 0 };
    }

    const now = new Date().toISOString();
    if (terms.length) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(GLOBAL_IGNORED_TERMS_SETTING, JSON.stringify(terms));
    } else {
        db.prepare('DELETE FROM settings WHERE key=?').run(GLOBAL_IGNORED_TERMS_SETTING);
    }
    globalIgnoredTermsCache = terms;
    seriesIgnoredTermsCache.clear();

    const qcFilesMarkedForRecheck = Number(qcDb.prepare('UPDATE qc_cache SET parser_version=0').run().changes || 0);
    const invalidatedDismissals = Number(qcDb.prepare('DELETE FROM qc_dismissed').run().changes || 0);
    db.prepare('UPDATE library_series_state SET last_scanned_at=NULL, updated_at=?').run(now);
    log(`Updated global ignored chapter filename terms: ${terms.length} term(s); ${qcFilesMarkedForRecheck} QC result(s) marked for recheck; ${invalidatedDismissals} prior QC dismissal(s) reset.`);
    return { terms: [...terms], changed: true, qcFilesMarkedForRecheck, invalidatedDismissals };
}

function invalidateSeriesQcCache(series) {
    const { destRoot } = getRoots();
    const seriesPath = destRoot ? path.resolve(destRoot, series) : '';
    if (!destRoot || !isWithin(destRoot, seriesPath) || samePath(destRoot, seriesPath)) return 0;
    const prefix = path.join(seriesPath, '');
    const cacheChanges = qcDb.prepare('DELETE FROM qc_cache WHERE substr(path, 1, length(?)) = ? COLLATE NOCASE').run(prefix, prefix).changes;

    qcDb.prepare('DELETE FROM qc_dismissed WHERE substr(path, 1, length(?)) = ? COLLATE NOCASE').run(prefix, prefix);
    db.prepare('UPDATE library_series_state SET last_scanned_at=NULL, updated_at=? WHERE lower(series)=lower(?)')
        .run(new Date().toISOString(), String(series));
    return cacheChanges;
}

function setSeriesIgnoredTerms(series, inputTerms) {
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    const terms = normalizeIgnoredTerms(inputTerms);
    const now = new Date().toISOString();
    if (terms.length) {
        db.prepare(`INSERT INTO series_ignored_terms (series, terms_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(series) DO UPDATE SET terms_json=excluded.terms_json, updated_at=excluded.updated_at`)
            .run(validation.value, JSON.stringify(terms), now);
    } else {
        db.prepare('DELETE FROM series_ignored_terms WHERE lower(series)=lower(?)').run(validation.value);
    }
    seriesIgnoredTermsCache.set(volumeModeCacheKey(validation.value), terms);
    const cleared = invalidateSeriesQcCache(validation.value);
    log(`Updated ignored chapter filename terms for ${validation.value}: ${terms.length} term(s); ${cleared} QC cache result(s) queued for recheck.`);
    return [...terms];
}

function renameSeriesIgnoredTerms(oldName, newName) {
    const oldKey = volumeModeCacheKey(oldName);
    const newKey = volumeModeCacheKey(newName);
    const existing = db.prepare('SELECT terms_json FROM series_ignored_terms WHERE lower(series)=lower(?)').get(String(oldName));
    const target = db.prepare('SELECT 1 FROM series_ignored_terms WHERE lower(series)=lower(?)').get(String(newName));
    if (existing && !target) {
        db.prepare('UPDATE series_ignored_terms SET series=?, updated_at=? WHERE lower(series)=lower(?)')
            .run(String(newName), new Date().toISOString(), String(oldName));
        let terms = [];
        try { terms = normalizeIgnoredTerms(JSON.parse(existing.terms_json || '[]')); } catch (_) { terms = []; }
        seriesIgnoredTermsCache.set(newKey, terms);
    } else if (target) {

        db.prepare('DELETE FROM series_ignored_terms WHERE lower(series)=lower(?)').run(String(oldName));
        seriesIgnoredTermsCache.delete(newKey);
    }
    seriesIgnoredTermsCache.delete(oldKey);
}

function parseSeriesChapter(filename, series, modeOverride = null) {
    const volumeMode = VALID_VOLUME_MODES.has(String(modeOverride || '')) ? String(modeOverride) : getSeriesVolumeMode(series);
    const options = { volumeMode, ignoredTerms: getEffectiveIgnoredTerms(series) };
    return parseChapter(filename, series, options) || parseChapter(filename, '', options);
}

function parseSeriesChapterLabel(label, series) {
    return parseChapterLabel(label, { volumeMode: getSeriesVolumeMode(series), ignoredTerms: getEffectiveIgnoredTerms(series) });
}

function resolveChapterOverride(parsedFromFilename, parsedOverride, override, series) {
    if (!parsedOverride || !override) return parsedFromFilename;
    const mode = getSeriesVolumeMode(series);
    if (parsedOverride.special) {
        return {
            ...parsedOverride,
            label: override.chapter_label || parsedOverride.label,
            key: override.chapter_key || parsedOverride.key,
            special: true
        };
    }
    if (mode === 'volume-only') {

        if (parsedOverride.volumeKey || parsedOverride.isVolume) return parsedOverride;
        if (parsedFromFilename?.volumeKey || parsedFromFilename?.isVolume) return parsedFromFilename;
    }
    if (mode === 'volume-chapters') {
        if (parsedOverride.volumeKey) return parsedOverride;
        if (parsedFromFilename?.volumeKey && !parsedFromFilename.special) {
            return {
                ...parsedOverride,
                label: `${parsedFromFilename.volumeLabel} - ${parsedOverride.label}`,
                key: `volume:${parsedFromFilename.volumeKey}|${String(parsedOverride.key || '').split('|').pop()}`,
                volumeNumber: parsedFromFilename.volumeNumber,
                volumeEndNumber: parsedFromFilename.volumeEndNumber,
                volumeKey: parsedFromFilename.volumeKey,
                volumeLabel: parsedFromFilename.volumeLabel,
                isVolume: false,
                volumeOnly: false
            };
        }
    }
    return {
        ...parsedOverride,
        label: override.chapter_label || parsedOverride.label,
        key: override.chapter_key || parsedOverride.key,
        special: Boolean(parsedOverride.special || String(override.chapter_key || '').startsWith('special:'))
    };
}

function getRoots() {
    return {
        sourceRoot: String(getSetting('sourceRoot', '')).trim(),
        destRoot: String(getSetting('destination', '')).trim()
    };
}

function isWithin(parentPath, candidatePath) {
    const parent = path.resolve(parentPath);
    const candidate = path.resolve(candidatePath);
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathKey(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
    return pathKey(a) === pathKey(b);
}

function getPathPresence(targetPath) {
    if (!targetPath) return null;
    const { sourceRoot, destRoot } = getRoots();
    const matchingRoots = [sourceRoot, destRoot].filter(root => root && isWithin(root, targetPath));
    const accessible = matchingRoots.some(root => {
        try { return fs.statSync(root).isDirectory(); }
        catch (_) { return false; }
    });
    if (!accessible) return null;
    try { fs.statSync(targetPath); return true; }
    catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        return null;
    }
}

async function yieldToPipeline() {

    while (pipelinePromise || activeQcMutations > 0) await new Promise(resolve => setTimeout(resolve, 250));
}

function beginQcMutation() {
    activeQcMutations++;
}

function endQcMutation() {
    activeQcMutations = Math.max(0, activeQcMutations - 1);
    if (activeQcMutations === 0) {
        while (qcMutationWaiters.length) qcMutationWaiters.shift()();
    }
}

async function waitForQcMutations() {
    while (activeQcMutations > 0) {
        await new Promise(resolve => qcMutationWaiters.push(resolve));
    }
}

async function waitForCoverMutations() {
    while (activeCoverMutations > 0) {
        await new Promise(resolve => coverMutationWaiters.push(resolve));
    }
}

function beginCoverMutation() {
    activeCoverMutations++;
}

function endCoverMutation() {
    activeCoverMutations = Math.max(0, activeCoverMutations - 1);
    if (activeCoverMutations === 0) while (coverMutationWaiters.length) coverMutationWaiters.shift()();
}

const COVER_EXT_PATTERN = /\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?)$/i;
const KAVITA_SERIES_COVER_FILENAME = 'PanelKeeper-Kavita-Series-Cover.webp';
const KAVITA_SERIES_COVER_STEM = 'panelkeeper-kavita-series-cover';

function isKavitaSeriesCoverName(name) {
    return path.basename(String(name || ''), path.extname(String(name || ''))).toLowerCase() === KAVITA_SERIES_COVER_STEM;
}

function getKavitaSeriesCoverPath(seriesPath) {
    const preferredPath = path.join(seriesPath, KAVITA_SERIES_COVER_FILENAME);
    if (fs.existsSync(preferredPath)) return preferredPath;

    try {
        const matches = fs.readdirSync(seriesPath, { withFileTypes: true })
            .filter(entry => entry.isFile() && isKavitaSeriesCoverName(entry.name) && COVER_EXT_PATTERN.test(entry.name))
            .map(entry => path.join(seriesPath, entry.name));
        matches.sort((a, b) => {
            const rank = file => path.extname(file).toLowerCase() === '.webp' ? 0
                : path.extname(file).toLowerCase() === '.png' ? 1
                : path.extname(file).toLowerCase() === '.jpg' || path.extname(file).toLowerCase() === '.jpeg' ? 2 : 3;
            return rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
        return matches[0] || preferredPath;
    } catch (_) { return preferredPath; }
}

function coverCandidateRank(name) {
    const stem = path.basename(name, path.extname(name)).toLowerCase().replace(/[_ ]/g, '-');
    if (stem === 'c-cover') return 0;
    if (stem === 'cover') return 1;
    if (stem === 'folder') return 2;
    if (stem === 'poster') return 3;

    if (isKavitaSeriesCoverName(name)) return 4;
    return 99;
}

function coverCandidateType(item) {
    if (isKavitaSeriesCoverName(item?.name)) return 'Kavita manga main cover · preferred fallback';
    if (item?.rank === 0) return 'c-cover · highest priority';
    if (item?.rank < 99) return 'Series folder cover';
    return 'Other image · manual selection';
}

function compareCoverCandidates(a, b) {
    const aName = String(a?.name || path.basename(String(a?.path || '')));
    const bName = String(b?.name || path.basename(String(b?.path || '')));
    const aRank = Number.isFinite(Number(a?.rank)) ? Number(a.rank) : coverCandidateRank(aName);
    const bRank = Number.isFinite(Number(b?.rank)) ? Number(b.rank) : coverCandidateRank(bName);
    const formatRank = name => {
        if (!isKavitaSeriesCoverName(name)) return 0;
        const ext = path.extname(name).toLowerCase();
        return ext === '.webp' ? 0 : ext === '.png' ? 1 : (ext === '.jpg' || ext === '.jpeg') ? 2 : 3;
    };
    return aRank - bRank || formatRank(aName) - formatRank(bName)
        || aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
}

async function listSeriesCoverCandidates(seriesPath) {
    let entries = [];
    try { entries = await fs.readdir(seriesPath, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return entries.filter(entry => entry.isFile() && COVER_EXT_PATTERN.test(entry.name))
        .map(entry => ({
            name: entry.name,
            path: path.join(seriesPath, entry.name),

            rank: coverCandidateRank(entry.name)
        }))
        .sort(compareCoverCandidates);
}

async function importSeriesCoverImage(series, originalFilename, contentType, buffer) {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) throw new Error('The configured manga library is not accessible. Check Settings → Test Paths.');
    const rootPath = await fs.realpath(destRoot);
    const requestedSeriesPath = path.resolve(rootPath, target.value);
    if (!isWithin(rootPath, requestedSeriesPath) || path.dirname(requestedSeriesPath) !== rootPath) throw new Error('Invalid manga folder.');
    const seriesPath = await fs.realpath(requestedSeriesPath).catch(() => null);
    if (!seriesPath || !isWithin(rootPath, seriesPath) || path.dirname(seriesPath) !== rootPath) throw new Error('The selected manga folder is not accessible inside the configured library.');
    const stat = await fs.stat(seriesPath);
    if (!stat.isDirectory()) throw new Error('The selected manga library path is not a folder.');

    const validated = coverImportUtils.validateCoverUpload(buffer, contentType, originalFilename);
    const candidates = await listSeriesCoverCandidates(seriesPath);
    const hasRecognizedCover = candidates.some(item => item.rank < 99);
    let filename = hasRecognizedCover
        ? `PanelKeeper-Cover-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}${validated.extension}`
        : `cover${validated.extension}`;
    let targetPath = path.join(seriesPath, filename);
    while (await fs.pathExists(targetPath)) {
        filename = `PanelKeeper-Cover-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${validated.extension}`;
        targetPath = path.join(seriesPath, filename);
    }
    await fs.writeFile(targetPath, buffer, { flag: 'wx', mode: 0o644 });
    log(`Imported cover image into ${target.value}: ${filename}`);
    return {
        success: true,
        series: target.value,
        name: filename,
        path: targetPath,
        selectedByDefault: !hasRecognizedCover,
        message: `Saved ${filename} in the ${target.value} manga folder.`
    };
}

async function resolveSeriesCoverPath(seriesPath, selectedPath = '') {
    if (selectedPath) {
        const resolved = path.resolve(selectedPath);
        if (!isWithin(seriesPath, resolved) || samePath(seriesPath, resolved)) throw new Error('The selected cover image must be inside the manga series folder.');
        if (!COVER_EXT_PATTERN.test(resolved)) throw new Error('The selected file is not a supported cover image.');
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Selected cover image was not found: ${resolved}`);
        return resolved;
    }
    const candidates = await listSeriesCoverCandidates(seriesPath);
    return candidates.find(item => item.rank < 99)?.path || null;
}

function getCoverRule(series) {
    return db.prepare('SELECT * FROM series_cover_rules WHERE lower(target_series)=lower(?)').get(String(series || '').trim()) || null;
}

function getChapterCoverDesign(series) {
    const row = db.prepare('SELECT * FROM series_chapter_cover_designs WHERE lower(target_series)=lower(?)').get(String(series || '').trim());
    if (!row) return null;
    return {
        ...chapterCoverGenerator.normalizeDesign({
            position: row.position, template: row.template, fontSize: row.font_size,
            textColor: row.text_color, outlineColor: row.outline_color, outlineWidth: row.outline_width,
            panelEnabled: Boolean(row.panel_enabled), panelColor: row.panel_color, panelOpacity: row.panel_opacity
        }),
        series: row.target_series, enabled: Boolean(row.enabled), sourcePath: row.source_path || '', updatedAt: row.updated_at || null
    };
}

function chapterDesignHash(sourceHash, design, chapter) {
    return crypto.createHash('sha256').update(JSON.stringify({
        sourceHash, design: chapterCoverGenerator.normalizeDesign(design), chapterKey: chapter.key,
        chapterLabel: chapter.label, outputFormat: 'webp-lossless-v1'
    })).digest('hex');
}

async function applyChapterCoverDesignToFile(archivePath, series, designOverride = null) {
    const { destRoot } = getRoots();
    const resolvedArchive = path.resolve(archivePath);
    const seriesPath = path.resolve(destRoot || '', series);
    if (!destRoot || !isWithin(destRoot, resolvedArchive) || path.dirname(resolvedArchive) !== seriesPath || path.extname(resolvedArchive).toLowerCase() !== '.cbz') {
        return { changed: false, skipped: true, reason: 'outside_library' };
    }
    const design = designOverride || getChapterCoverDesign(series);
    if (!design?.enabled) return { changed: false, skipped: true, reason: 'design_disabled' };
    const chapter = parseSeriesChapter(path.basename(resolvedArchive), series);
    if (!chapter) return { changed: false, skipped: true, reason: 'unparsed_chapter' };
    const coverPath = await resolveSeriesCoverPath(seriesPath, design.sourcePath || '');
    if (!coverPath) throw new Error(`No cover image found in ${seriesPath}. Add a recognized cover or choose an image from the series folder.`);
    const sourceData = await fs.readFile(coverPath);
    const sourceHash = crypto.createHash('sha256').update(sourceData).digest('hex');
    const designHash = chapterDesignHash(sourceHash, design, chapter);
    const before = await fs.stat(resolvedArchive);
    const applied = db.prepare('SELECT design_hash, source_hash, archive_size, archive_mtime FROM chapter_cover_insertions WHERE archive_path=?').get(resolvedArchive);
    if (applied && applied.design_hash === designHash && applied.source_hash === sourceHash
        && Number(applied.archive_size) === before.size && Number(applied.archive_mtime) === Math.floor(before.mtimeMs)) {
        return { changed: false, skipped: true, reason: 'already_current' };
    }
    const buffer = await chapterCoverGenerator.generateChapterCoverBuffer(coverPath, chapter, series, design);
    const result = await zip.setManagedFirstImageBufferInPlace(resolvedArchive, buffer, '.webp');
    const after = await fs.stat(resolvedArchive);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO chapter_cover_insertions (archive_path, series, source_path, source_hash, design_hash, chapter_key, archive_size, archive_mtime, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(archive_path) DO UPDATE SET series=excluded.series, source_path=excluded.source_path,
            source_hash=excluded.source_hash, design_hash=excluded.design_hash, chapter_key=excluded.chapter_key,
            archive_size=excluded.archive_size, archive_mtime=excluded.archive_mtime, applied_at=excluded.applied_at`)
        .run(resolvedArchive, series, coverPath, sourceHash, designHash, chapter.key, after.size, Math.floor(after.mtimeMs), now);
    db.prepare('DELETE FROM cover_insertions WHERE archive_path=?').run(resolvedArchive);
    if (result.changed) log(`[CHAPTER COVER GENERATED] ${path.basename(resolvedArchive)} · ${series} · ${chapter.label}`);
    return { ...result, coverPath, chapterLabel: chapter.label };
}

function normalizeKavitaBaseUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Enter the base URL for your Kavita server.');
    let parsed;
    try { parsed = new URL(raw); }
    catch (_) { throw new Error('Enter a valid Kavita URL, for example http://localhost:5000.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Kavita URL must use HTTP or HTTPS and cannot contain credentials, query parameters, or a fragment.');
    }
    let pathname = parsed.pathname.replace(/\/+$/g, '');

    pathname = pathname.replace(/\/api$/i, '');
    return `${parsed.origin}${pathname}`.replace(/\/+$/g, '');
}

function getKavitaConnectionConfig() {
    return {
        baseUrl: String(getSetting('kavitaBaseUrl', '') || '').trim(),
        apiKey: String(getSetting('kavitaApiKey', '') || '').trim()
    };
}

function getKavitaConnectionStatus() {
    const config = getKavitaConnectionConfig();
    return { baseUrl: config.baseUrl, hasApiKey: Boolean(config.apiKey), configured: Boolean(config.baseUrl && config.apiKey) };
}

async function kavitaApiRequest(route, { config = getKavitaConnectionConfig(), image = false } = {}) {
    if (!config.baseUrl || !config.apiKey) throw new Error('Configure and test your Kavita URL and API key first.');
    const target = new URL(`${config.baseUrl}${route.startsWith('/') ? route : `/${route}`}`);
    const headers = { 'x-api-key': config.apiKey, accept: image ? 'image/*' : 'application/json' };

    const sendRequest = async requestUrl => {
        try {
            return await fetch(requestUrl, {
                method: 'GET', headers, redirect: 'error',
                signal: AbortSignal.timeout(25000)
            });
        } catch (error) {
            throw new Error(`Could not reach Kavita at ${config.baseUrl}: ${error.message}`);
        }
    };

    let response = await sendRequest(target);
    let errorDetail = '';
    if (!response.ok) errorDetail = (await response.text().catch(() => '')).slice(0, 1000);

    const legacyImageApiKeyRequired = image && response.status === 400
        && /"apiKey"\s*:\s*\[\s*"The apiKey field is required\."\s*\]/i.test(errorDetail);
    if (legacyImageApiKeyRequired) {
        const legacyTarget = new URL(target);
        legacyTarget.searchParams.set('apiKey', config.apiKey);
        log('[KAVITA] Older ImageController requires its legacy apiKey query argument; retrying the series-cover request with server-side compatibility handling.');
        response = await sendRequest(legacyTarget);
        errorDetail = '';
        if (!response.ok) errorDetail = (await response.text().catch(() => '')).slice(0, 300);
    }

    if (!response.ok) {
        const detail = errorDetail ? `: ${errorDetail.slice(0, 300)}` : '';
        throw new Error(`Kavita returned HTTP ${response.status}${detail}`);
    }
    if (image) {
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.startsWith('image/')) throw new Error(`Kavita returned ${contentType || 'an unknown content type'} instead of a cover image.`);
        const length = Number(response.headers.get('content-length') || 0);
        if (length > 32 * 1024 * 1024) throw new Error('Kavita cover image exceeds the 32 MiB download limit.');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > 32 * 1024 * 1024) throw new Error('Kavita returned an empty or oversized cover image.');
        return buffer;
    }
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; }
    catch (_) { throw new Error('Kavita returned an invalid JSON response.'); }
}

async function saveKavitaConnection({ baseUrl, apiKey } = {}) {
    const normalizedUrl = normalizeKavitaBaseUrl(baseUrl);
    const previous = getKavitaConnectionConfig();
    const normalizedKey = String(apiKey || '').trim() || previous.apiKey;
    if (!normalizedKey) throw new Error('Enter your Kavita API key.');
    const candidate = { baseUrl: normalizedUrl, apiKey: normalizedKey };

    await kavitaApiRequest(`/api/Search/search?queryString=${encodeURIComponent('PanelKeeper connection check')}&includeChapterAndFiles=false`, { config: candidate });
    const save = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const transaction = db.transaction(() => {
        save.run('kavitaBaseUrl', normalizedUrl);
        save.run('kavitaApiKey', normalizedKey);
    });
    transaction();
    log(`Kavita connection verified and saved: ${normalizedUrl}. API key is stored server-side and is not returned to the browser.`);
    return getKavitaConnectionStatus();
}

async function searchKavitaSeries(query) {
    const term = String(query || '').trim().slice(0, 160);
    if (term.length < 2) throw new Error('Enter at least two characters to search Kavita.');
    const data = await kavitaApiRequest(`/api/Search/search?queryString=${encodeURIComponent(term)}&includeChapterAndFiles=false`);
    const series = Array.isArray(data?.series) ? data.series : [];
    return series.filter(item => Number.isSafeInteger(Number(item.seriesId)) && Number(item.seriesId) > 0).slice(0, 50).map(item => ({
        id: Number(item.seriesId),
        name: String(item.name || item.originalName || item.localizedName || `Kavita series ${item.seriesId}`),
        originalName: String(item.originalName || ''),
        localizedName: String(item.localizedName || ''),
        libraryName: String(item.libraryName || ''),
        volumeCount: Number(item.volumeCount || 0),
        chapterCount: Number(item.chapterCount || 0)
    }));
}

async function findKavitaSeriesMatch(series) {
    const localName = String(series || '').trim();
    if (localName.length < 2) throw new Error('Select a manga with a title containing at least two characters.');
    const rows = await searchKavitaSeries(localName);
    const exact = findExactKavitaSeriesMatch(localName, rows);
    return {
        match: exact.match,
        ambiguous: exact.matches.length > 1,
        exactMatches: exact.matches,
        suggestions: rows.slice(0, 12)
    };
}

function getSeriesKavitaCoverSource(series) {
    const row = db.prepare('SELECT * FROM series_kavita_cover_sources WHERE lower(target_series)=lower(?)').get(String(series || '').trim());
    if (!row) return null;
    return {
        series: row.target_series,
        enabled: Boolean(row.enabled),
        autoCoverEnabled: Boolean(row.auto_cover_enabled),
        kavitaSeriesId: Number(row.kavita_series_id || 0),
        kavitaSeriesName: String(row.kavita_series_name || ''),
        updatedAt: row.updated_at || null,
        lastJobId: row.last_job_id || ''
    };
}

async function getKavitaCoverSettings(series) {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot || '', target.value);
    const source = getSeriesKavitaCoverSource(target.value);
    const coverPath = getKavitaSeriesCoverPath(seriesPath);
    const coverFileAvailable = Boolean(destRoot && isWithin(destRoot, seriesPath)
        && await fs.pathExists(coverPath).catch(() => false));
    return {
        connection: getKavitaConnectionStatus(),
        source,
        autoCoverEnabled: Boolean(source?.autoCoverEnabled),
        coverFileName: coverFileAvailable ? path.basename(coverPath) : KAVITA_SERIES_COVER_FILENAME,
        coverFileAvailable,
        coverPath: coverFileAvailable ? coverPath : ''
    };
}

async function fetchKavitaSeriesCoverImage(kavitaSeriesId) {
    const id = Number(kavitaSeriesId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Choose a valid Kavita series first.');
    const downloaded = await kavitaApiRequest(`/api/Image/series-cover?seriesId=${encodeURIComponent(id)}`, { image: true });
    return sharp(downloaded, { failOn: 'error', limitInputPixels: 80000000 })
        .rotate().webp({ quality: 95, effort: 6 }).toBuffer();
}

async function getKavitaSeriesCoverPreview(kavitaSeriesId) {
    return fetchKavitaSeriesCoverImage(kavitaSeriesId);
}

async function saveKavitaSeriesCoverSource(series, enabled, kavitaSeriesId = null, kavitaSeriesName = '') {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) throw new Error('The configured manga library is not accessible. Check Settings → Test Paths.');
    const rootPath = await fs.realpath(destRoot);
    const requestedSeriesPath = path.resolve(rootPath, target.value);
    if (!isWithin(rootPath, requestedSeriesPath) || path.dirname(requestedSeriesPath) !== rootPath) throw new Error('Invalid manga folder.');
    const seriesPath = await fs.realpath(requestedSeriesPath).catch(() => null);
    if (!seriesPath || !isWithin(rootPath, seriesPath) || path.dirname(seriesPath) !== rootPath) throw new Error('The selected manga folder is not accessible inside the configured library.');
    const stat = await fs.stat(seriesPath);
    if (!stat.isDirectory()) throw new Error('The selected manga library path is not a folder.');

    const previous = getSeriesKavitaCoverSource(target.value);
    const resolvedId = Number(kavitaSeriesId || previous?.kavitaSeriesId || 0);
    const shouldEnable = enabled === true;
    const coverPath = path.join(seriesPath, KAVITA_SERIES_COVER_FILENAME);
    let imageHash = '';
    if (shouldEnable) {
        if (!Number.isSafeInteger(resolvedId) || resolvedId <= 0) throw new Error('Search Kavita and select the matching series first.');
        const config = getKavitaConnectionConfig();
        if (!config.baseUrl || !config.apiKey) throw new Error('Save and test the Kavita connection in Settings before fetching a manga cover.');
        const imageBuffer = await fetchKavitaSeriesCoverImage(resolvedId);
        imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
        const tempPath = `${coverPath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, imageBuffer, { flag: 'wx', mode: 0o644 });
            await fs.move(tempPath, coverPath, { overwrite: true });
        } catch (error) {
            await fs.remove(tempPath).catch(() => {});
            throw new Error(`Kavita returned the manga cover, but PanelKeeper could not save it: ${error.message}`);
        }
    }

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO series_kavita_cover_sources (target_series, enabled, kavita_series_id, kavita_series_name, last_job_id, updated_at)
        VALUES (?, ?, ?, ?, '', ?) ON CONFLICT(target_series) DO UPDATE SET enabled=excluded.enabled,
        kavita_series_id=excluded.kavita_series_id, kavita_series_name=excluded.kavita_series_name,
        last_job_id='', updated_at=excluded.updated_at`)
        .run(target.value, shouldEnable ? 1 : 0, resolvedId,
            String(kavitaSeriesName || previous?.kavitaSeriesName || '').trim().slice(0, 300), now);
    if (shouldEnable) log(`[KAVITA SERIES COVER] Downloaded Kavita main manga cover for ${target.value} from series ${resolvedId} (${imageHash.slice(0, 12)}).`);
    else log(`[KAVITA SERIES COVER] Disabled the automatic Kavita main-cover source for ${target.value}; the downloaded folder image was retained as a normal selectable cover.`);
    return {
        success: true,
        series: target.value,
        enabled: shouldEnable,
        kavitaSeriesId: resolvedId,
        kavitaSeriesName: String(kavitaSeriesName || previous?.kavitaSeriesName || '').trim().slice(0, 300),
        coverFileName: KAVITA_SERIES_COVER_FILENAME,
        coverFileAvailable: await fs.pathExists(coverPath),
        coverHash: imageHash,
        message: shouldEnable
            ? `Downloaded Kavita's main manga cover into ${target.value}/${KAVITA_SERIES_COVER_FILENAME}. No chapter archives were modified.`
            : 'Kavita automatic cover sourcing is disabled. The downloaded image remains in the manga folder and can still be selected manually.'
    };
}

async function downloadKavitaMainCover(series, kavitaSeriesId = null, kavitaSeriesName = '', overwriteExisting = false) {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) throw new Error('The configured manga library is not accessible. Check Settings → Test Paths.');
    const rootPath = await fs.realpath(destRoot);
    const requestedSeriesPath = path.resolve(rootPath, target.value);
    if (!isWithin(rootPath, requestedSeriesPath) || path.dirname(requestedSeriesPath) !== rootPath) throw new Error('Invalid manga folder.');
    const seriesPath = await fs.realpath(requestedSeriesPath).catch(() => null);
    if (!seriesPath || !isWithin(rootPath, seriesPath) || path.dirname(seriesPath) !== rootPath) throw new Error('The selected manga folder is not accessible inside the configured library.');
    const stat = await fs.stat(seriesPath);
    if (!stat.isDirectory()) throw new Error('The selected manga library path is not a folder.');

    const previous = getSeriesKavitaCoverSource(target.value);
    const resolvedId = Number(kavitaSeriesId || previous?.kavitaSeriesId || 0);
    if (!Number.isSafeInteger(resolvedId) || resolvedId <= 0) throw new Error('Choose the matching Kavita manga first.');
    const config = getKavitaConnectionConfig();
    if (!config.baseUrl || !config.apiKey) throw new Error('Save and test the Kavita connection in Settings before downloading a manga cover.');

    const displayName = String(kavitaSeriesName || previous?.kavitaSeriesName || '').trim().slice(0, 300);
    const existingCoverPath = getKavitaSeriesCoverPath(seriesPath);
    const existingCoverAvailable = await fs.pathExists(existingCoverPath).catch(() => false);
    const rememberMatch = () => {
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO series_kavita_cover_sources
            (target_series, enabled, auto_cover_enabled, kavita_series_id, kavita_series_name, last_job_id, updated_at)
            VALUES (?, 0, 0, ?, ?, '', ?)
            ON CONFLICT(target_series) DO UPDATE SET
                kavita_series_id=excluded.kavita_series_id,
                kavita_series_name=excluded.kavita_series_name,
                updated_at=excluded.updated_at`)
            .run(target.value, resolvedId, displayName, now);
    };

    if (existingCoverAvailable && overwriteExisting !== true) {
        rememberMatch();
        return {
            success: true,
            skippedExisting: true,
            series: target.value,
            kavitaSeriesId: resolvedId,
            kavitaSeriesName: displayName,
            coverFileName: path.basename(existingCoverPath),
            coverFileAvailable: true,
            coverPath: existingCoverPath,
            autoCoverEnabled: Boolean(previous?.autoCoverEnabled),
            sourceEnabled: Boolean(previous?.enabled),
            message: `A Kavita main cover already exists in ${target.value} (${path.basename(existingCoverPath)}). The existing image was kept. Review the live preview and check the overwrite option before downloading a replacement.`
        };
    }

    const imageBuffer = await fetchKavitaSeriesCoverImage(resolvedId);
    const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
    const coverPath = path.join(seriesPath, KAVITA_SERIES_COVER_FILENAME);
    const tempPath = `${coverPath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tempPath, imageBuffer, { flag: 'wx', mode: 0o644 });
        await fs.move(tempPath, coverPath, { overwrite: true });
    } catch (error) {
        await fs.remove(tempPath).catch(() => {});
        throw new Error(`Kavita returned the manga cover, but PanelKeeper could not save it: ${error.message}`);
    }

    rememberMatch();
    log(`[KAVITA COVER DOWNLOAD] ${existingCoverAvailable ? 'Replaced' : 'Saved'} standalone main manga cover for ${target.value} from Kavita series ${resolvedId} (${imageHash.slice(0, 12)}). Auto Cover and chapter archives were not changed.`);
    return {
        success: true,
        skippedExisting: false,
        series: target.value,
        kavitaSeriesId: resolvedId,
        kavitaSeriesName: displayName,
        coverFileName: KAVITA_SERIES_COVER_FILENAME,
        coverFileAvailable: true,
        coverPath,
        autoCoverEnabled: Boolean(previous?.autoCoverEnabled),
        sourceEnabled: Boolean(previous?.enabled),
        coverHash: imageHash,
        message: `${existingCoverAvailable ? 'Replaced' : 'Downloaded'} Kavita's main manga cover as WebP in ${target.value}/${KAVITA_SERIES_COVER_FILENAME}. It is available for manual selection; no cover rule or chapter CBZ was changed.`
    };
}

async function setKavitaAutoCover(series, enabled, forceRefresh = false, selectedKavitaSeriesId = null, selectedKavitaSeriesName = '') {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    let linkedSource = getSeriesKavitaCoverSource(target.value);

    const { destRoot } = getRoots();
    if (!destRoot) throw new Error('The configured manga library is not available.');
    const seriesPath = path.resolve(destRoot, target.value);
    if (!isWithin(destRoot, seriesPath) || !fs.existsSync(seriesPath)) throw new Error('The selected manga folder is not accessible.');
    let kavitaCoverPath = getKavitaSeriesCoverPath(seriesPath);
    const now = new Date().toISOString();

    if (!enabled) {
        const currentDesign = getChapterCoverDesign(target.value) || {};
        const saved = saveChapterCoverDesign(target.value, false, '', currentDesign);
        db.prepare('UPDATE series_kavita_cover_sources SET auto_cover_enabled=0, updated_at=? WHERE lower(target_series)=lower(?)')
            .run(now, target.value);
        log(`[KAVITA AUTO COVER] Disabled automatic Kavita-generated chapter covers for ${target.value}. Existing generated images are queued for removal; any enabled static cover rule will be restored.`);
        return {
            success: true,
            enabled: false,
            series: target.value,
            coverPath: kavitaCoverPath,
            design: saved.design,
            job: saved.job,
            message: `Auto Cover disabled for ${target.value}. Existing generated chapter covers are queued for removal; the static cover rule will be restored if one is enabled.`
        };
    }

    const requestedId = Number(selectedKavitaSeriesId || linkedSource?.kavitaSeriesId || 0);
    if (!Number.isSafeInteger(requestedId) || requestedId <= 0) {
        throw new Error('PanelKeeper could not identify the matching Kavita series automatically. Use the inline Kavita search to select the correct series.');
    }
    const requestedName = String(selectedKavitaSeriesName || linkedSource?.kavitaSeriesName || '').trim().slice(0, 300);
    const linkChanged = Number(linkedSource?.kavitaSeriesId || 0) !== requestedId;
    const coverExists = await fs.pathExists(kavitaCoverPath);
    const needsFetch = Boolean(forceRefresh || linkChanged || !coverExists);

    if (needsFetch) {
        await saveKavitaSeriesCoverSource(target.value, true, requestedId, requestedName);
        kavitaCoverPath = getKavitaSeriesCoverPath(seriesPath);
    } else {
        db.prepare(`UPDATE series_kavita_cover_sources SET enabled=1,
            kavita_series_name=CASE WHEN ? <> '' THEN ? ELSE kavita_series_name END, updated_at=?
            WHERE lower(target_series)=lower(?)`)
            .run(requestedName, requestedName, now, target.value);
    }

    linkedSource = getSeriesKavitaCoverSource(target.value);
    if (!linkedSource?.kavitaSeriesId || !(await fs.pathExists(kavitaCoverPath))) {
        throw new Error('Kavita main cover setup did not produce a usable manga cover image.');
    }

    const existingDesign = getChapterCoverDesign(target.value) || {};
    const autoDesign = chapterCoverGenerator.normalizeKavitaAutoCoverDesign(existingDesign);
    const saved = saveChapterCoverDesign(target.value, true, kavitaCoverPath, autoDesign);
    db.prepare('UPDATE series_kavita_cover_sources SET auto_cover_enabled=1, updated_at=? WHERE lower(target_series)=lower(?)')
        .run(new Date().toISOString(), target.value);
    log(`[KAVITA AUTO COVER] ${forceRefresh ? 'Refreshed' : 'Enabled'} for ${target.value}: ${path.basename(kavitaCoverPath)}, ${autoDesign.fontSize}% text, bottom-center; ${saved.job?.total || 0} existing chapter(s) queued.`);
    return {
        success: true,
        enabled: true,
        series: target.value,
        kavitaSeriesId: requestedId,
        kavitaSeriesName: linkedSource.kavitaSeriesName,
        coverPath: kavitaCoverPath,
        coverFileName: path.basename(kavitaCoverPath),
        design: saved.design,
        job: saved.job,
        message: `${forceRefresh ? 'Kavita cover refreshed' : 'Kavita Auto Cover enabled'} for ${target.value}. The Kavita manga cover is selected in the generator with ${autoDesign.fontSize}% text at bottom center. ${Number(saved.job?.total || 0).toLocaleString()} existing chapter(s) queued; future chapters will use the saved rule.`
    };
}

function saveCoverRulePreference(series, enabled, coverPath = '') {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot || '', target.value);
    if (!destRoot || !isWithin(destRoot, seriesPath) || !fs.existsSync(seriesPath)) throw new Error('The selected manga folder is not accessible.');
    const selected = String(coverPath || '').trim();
    if (enabled) {
        if (selected) {
            const resolved = path.resolve(selected);
            if (!isWithin(seriesPath, resolved) || samePath(seriesPath, resolved) || !COVER_EXT_PATTERN.test(path.basename(resolved)) || !fs.existsSync(resolved)) {
                throw new Error('Select an available cover image from this manga folder.');
            }
        } else {
            const candidates = fs.readdirSync(seriesPath, { withFileTypes: true })
                .filter(entry => entry.isFile() && COVER_EXT_PATTERN.test(entry.name))
                .map(entry => ({ path: path.join(seriesPath, entry.name), name: entry.name, rank: coverCandidateRank(entry.name) }))
                .sort(compareCoverCandidates);
            if (!candidates.some(entry => entry.rank < 99)) {
                throw new Error('No automatic folder cover was found. Choose a cover image or add c-cover, cover, folder, or poster to this manga folder.');
            }
        }
    }
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO series_cover_rules (target_series, enabled, cover_path, last_job_id, updated_at)
        VALUES (?, ?, ?, '', ?) ON CONFLICT(target_series) DO UPDATE SET enabled=excluded.enabled,
        cover_path=excluded.cover_path, last_job_id='', updated_at=excluded.updated_at`)
        .run(target.value, enabled ? 1 : 0, selected, now);
    return { series: target.value, enabled: Boolean(enabled), coverPath: selected };
}

async function saveChapterCoverSettings(series, input = {}) {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const staticEnabled = input.staticEnabled === true;
    const autoCoverEnabled = input.autoCoverEnabled === true;
    const coverPath = String(input.coverPath || '').trim();
    const forceRefresh = input.refreshKavitaCover === true;
    const currentSource = getSeriesKavitaCoverSource(target.value);

    let match = null;
    if (autoCoverEnabled) {
        const requestedId = Number(input.kavitaSeriesId || currentSource?.kavitaSeriesId || 0);
        if (requestedId > 0) {
            match = {
                id: requestedId,
                name: String(input.kavitaSeriesName || currentSource?.kavitaSeriesName || '').trim()
            };
        } else {
            const result = await findKavitaSeriesMatch(target.value);
            if (!result.match) {
                const error = new Error(result.ambiguous
                    ? `More than one Kavita series exactly matches "${target.value}". Open the inline Kavita search and choose the correct library entry.`
                    : `No exact Kavita series match was found for "${target.value}". Open the inline Kavita search and choose its Kavita series.`);
                error.code = 'KAVITA_MATCH_REQUIRED';
                error.details = { ambiguous: result.ambiguous, suggestions: result.suggestions };
                throw error;
            }
            match = result.match;
        }
        const connection = getKavitaConnectionStatus();
        if (!connection.configured) throw new Error('Connect Kavita in Settings before enabling Auto Cover.');
    }

    const previousAutoEnabled = Boolean(currentSource?.autoCoverEnabled);
    let staticRule = null;
    let staticJob = null;
    let autoResult = null;

    if (autoCoverEnabled) {
        autoResult = await setKavitaAutoCover(target.value, true, forceRefresh, match?.id, match?.name || '');
        const fallbackCoverPath = coverPath || (staticEnabled ? autoResult.coverPath : '');
        staticRule = saveCoverRulePreference(target.value, staticEnabled, fallbackCoverPath);
    } else if (previousAutoEnabled) {
        const kavitaMainCoverPath = getKavitaSeriesCoverPath(path.resolve(getRoots().destRoot || '', target.value));
        const fallbackCoverPath = coverPath || (staticEnabled && fs.existsSync(kavitaMainCoverPath) ? kavitaMainCoverPath : '');
        staticRule = saveCoverRulePreference(target.value, staticEnabled, fallbackCoverPath);
        autoResult = await setKavitaAutoCover(target.value, false);
    } else {
        staticJob = startCoverUpdateJob(target.value, staticEnabled, coverPath);
        staticRule = { series: target.value, enabled: staticEnabled, coverPath };
    }

    return {
        success: true,
        series: target.value,
        staticRule,
        staticJob,
        autoCoverEnabled,
        autoCover: autoResult,
        message: autoCoverEnabled
            ? `Saved ${target.value}. Kavita Auto Cover is active${staticEnabled ? ' and the static cover rule is saved as a fallback' : ''}.`
            : previousAutoEnabled
                ? `Saved ${target.value}. Auto Cover is disabled and the ${staticEnabled ? 'static cover rule has been restored' : 'managed generated covers are being removed'}.`
                : `Saved ${target.value}. Static cover rule ${staticEnabled ? 'enabled' : 'disabled'}.`
    };
}

async function applyCoverRuleToFile(archivePath, series) {
    const { destRoot } = getRoots();
    if (!destRoot || !isWithin(destRoot, archivePath) || path.extname(archivePath).toLowerCase() !== '.cbz') {
        return { changed: false, skipped: true, reason: 'outside_library' };
    }
    const resolvedArchive = path.resolve(archivePath);
    const design = getChapterCoverDesign(series);
    if (design?.enabled) return applyChapterCoverDesignToFile(resolvedArchive, series, design);

    const rule = getCoverRule(series);
    if (!rule || !rule.enabled) {
        const generatedRecord = db.prepare('SELECT 1 FROM chapter_cover_insertions WHERE archive_path=?').get(resolvedArchive);
        const staticRecord = db.prepare('SELECT 1 FROM cover_insertions WHERE archive_path=?').get(resolvedArchive);
        if (!generatedRecord && !staticRecord && !rule) return { changed: false, skipped: true, reason: 'no_rule' };
        const result = await zip.removeManagedFirstImageInPlace(resolvedArchive);
        db.prepare('DELETE FROM cover_insertions WHERE archive_path=?').run(resolvedArchive);
        db.prepare('DELETE FROM chapter_cover_insertions WHERE archive_path=?').run(resolvedArchive);
        if (result.changed) log(`[COVER REMOVED] ${path.basename(resolvedArchive)} · ${series}`);
        return { ...result, skipped: !result.changed };
    }
    const seriesPath = path.resolve(destRoot, series);
    const coverPath = await resolveSeriesCoverPath(seriesPath, rule.cover_path);
    if (!coverPath) throw new Error(`No cover image found in ${seriesPath}. Add c-cover, cover, folder, or poster image first.`);
    const result = await zip.setManagedFirstImageInPlace(resolvedArchive, coverPath);
    const stat = await fs.stat(resolvedArchive);
    if (result.hash) {
        db.prepare(`INSERT INTO cover_insertions (archive_path, series, cover_path, cover_hash, archive_size, archive_mtime, applied_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(archive_path) DO UPDATE SET series=excluded.series, cover_path=excluded.cover_path,
                cover_hash=excluded.cover_hash, archive_size=excluded.archive_size, archive_mtime=excluded.archive_mtime, applied_at=excluded.applied_at`)
            .run(resolvedArchive, series, coverPath, result.hash, stat.size, Math.floor(stat.mtimeMs), new Date().toISOString());
    }
    db.prepare('DELETE FROM chapter_cover_insertions WHERE archive_path=?').run(resolvedArchive);
    if (result.changed) log(`[COVER APPLIED] ${path.basename(resolvedArchive)} · ${series} · ${path.basename(coverPath)}`);
    return { ...result, coverPath };
}

function formatChapterCoverJob(row) {
    return {
        id: row.id, series: row.series, enabled: Boolean(row.enabled), status: row.status,
        total: row.total, done: row.done, applied: row.applied, skipped: row.skipped,
        errors: row.errors, createdAt: row.created_at, updatedAt: row.updated_at,
        finishedAt: row.finished_at, error: row.error
    };
}

function getLatestChapterCoverJob(series) {
    const row = db.prepare('SELECT * FROM chapter_cover_jobs WHERE lower(series)=lower(?) ORDER BY created_at DESC LIMIT 1').get(String(series || ''));
    return row ? formatChapterCoverJob(row) : null;
}

function getChapterCoverJobStatus(id) {
    const row = db.prepare('SELECT * FROM chapter_cover_jobs WHERE id=?').get(String(id));
    return row ? formatChapterCoverJob(row) : null;
}

async function getChapterCoverDesignPreview(series, chapterName, coverPath, inputDesign) {
    const { destRoot } = getRoots();
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const seriesPath = path.resolve(destRoot || '', target.value);
    if (!destRoot || !isWithin(destRoot, seriesPath) || !(await fs.pathExists(seriesPath))) throw new Error('Manga series folder is not accessible.');
    const archivePath = path.resolve(seriesPath, path.basename(String(chapterName || '')));
    if (path.dirname(archivePath) !== seriesPath || path.extname(archivePath).toLowerCase() !== '.cbz' || !(await fs.pathExists(archivePath))) {
        throw new Error('Choose an existing CBZ chapter for the generated-cover preview.');
    }
    const design = chapterCoverGenerator.normalizeDesign(inputDesign);
    const source = await resolveSeriesCoverPath(seriesPath, String(coverPath || ''));
    if (!source) throw new Error('Choose a supported cover image from this manga folder.');
    const chapter = parseSeriesChapter(path.basename(archivePath), target.value);
    if (!chapter) throw new Error('PanelKeeper could not identify this chapter number for the preview.');
    return chapterCoverGenerator.generateChapterCoverBuffer(source, chapter, target.value, design);
}

function supersedeCoverJobsForSeries(series, preferredQueue = '') {
    const target = String(series || '').trim();
    if (!target) return;
    const now = new Date().toISOString();
    if (preferredQueue !== 'generated') {
        const jobs = db.prepare("SELECT id FROM chapter_cover_jobs WHERE lower(series)=lower(?) AND status IN ('queued','running')").all(target);
        db.prepare("UPDATE chapter_cover_jobs SET status='superseded', updated_at=?, finished_at=?, error='Superseded by a newer cover rule for this manga.' WHERE lower(series)=lower(?) AND status IN ('queued','running')")
            .run(now, now, target);
        for (const job of jobs) db.prepare("UPDATE chapter_cover_job_items SET status='superseded' WHERE job_id=? AND status='pending'").run(job.id);
    }
    if (preferredQueue !== 'static') {
        const jobs = db.prepare("SELECT id FROM cover_update_jobs WHERE lower(series)=lower(?) AND status IN ('queued','running')").all(target);
        db.prepare("UPDATE cover_update_jobs SET status='superseded', updated_at=?, finished_at=?, error='Superseded by a newer cover rule for this manga.' WHERE lower(series)=lower(?) AND status IN ('queued','running')")
            .run(now, now, target);
        for (const job of jobs) db.prepare("UPDATE cover_update_items SET status='superseded' WHERE job_id=? AND status='pending'").run(job.id);
    }
}

function saveChapterCoverDesign(series, enabled, coverPath, inputDesign) {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot || '', target.value);
    if (!destRoot || !isWithin(destRoot, seriesPath) || !fs.existsSync(seriesPath)) throw new Error('The selected manga folder is not accessible.');
    const source = String(coverPath || '').trim();
    let resolvedSource = '';
    if (enabled) {
        if (!source) throw new Error('Choose a source cover image first.');
        resolvedSource = path.resolve(source);
        if (!isWithin(seriesPath, resolvedSource) || samePath(seriesPath, resolvedSource) || !COVER_EXT_PATTERN.test(resolvedSource) || !fs.existsSync(resolvedSource)) {
            throw new Error('The selected cover image must be an available image inside this manga folder.');
        }
    }
    const design = chapterCoverGenerator.normalizeDesign(inputDesign);
    const now = new Date().toISOString();
    const kavitaAutoSource = db.prepare('SELECT auto_cover_enabled FROM series_kavita_cover_sources WHERE lower(target_series)=lower(?)').get(target.value);
    if (kavitaAutoSource?.auto_cover_enabled) {
        const stillKavitaAuto = enabled && isKavitaSeriesCoverName(resolvedSource)
            && design.position === 'bottom-center' && design.fontSize >= 10
            && design.panelEnabled && design.panelOpacity >= 0.30 && design.panelOpacity <= 0.40;
        if (!stillKavitaAuto) {
            db.prepare('UPDATE series_kavita_cover_sources SET auto_cover_enabled=0, updated_at=? WHERE lower(target_series)=lower(?)')
                .run(now, target.value);
        }
    }
    db.prepare(`INSERT INTO series_chapter_cover_designs
        (target_series, enabled, source_path, template, position, font_size, text_color, outline_color, outline_width, panel_enabled, panel_color, panel_opacity, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_series) DO UPDATE SET enabled=excluded.enabled, source_path=excluded.source_path,
            template=excluded.template, position=excluded.position, font_size=excluded.font_size, text_color=excluded.text_color,
            outline_color=excluded.outline_color, outline_width=excluded.outline_width, panel_enabled=excluded.panel_enabled,
            panel_color=excluded.panel_color, panel_opacity=excluded.panel_opacity, updated_at=excluded.updated_at`)
        .run(target.value, enabled ? 1 : 0, resolvedSource, design.template, design.position, design.fontSize,
            design.textColor, design.outlineColor, design.outlineWidth, design.panelEnabled ? 1 : 0,
            design.panelColor, design.panelOpacity, now);

    const chapters = fs.readdirSync(seriesPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz')
        .map(entry => path.resolve(seriesPath, entry.name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const addItem = db.prepare("INSERT INTO chapter_cover_job_items (job_id, archive_path, status) VALUES (?, ?, 'pending')");
    let alreadyCurrent = 0;
    const pending = [];
    let sourceHash = '';
    if (enabled) sourceHash = crypto.createHash('sha256').update(fs.readFileSync(resolvedSource)).digest('hex');
    for (const archivePath of chapters) {
        let current = false;
        if (enabled) {
            try {
                const chapter = parseSeriesChapter(path.basename(archivePath), target.value);
                if (chapter) {
                    const stat = fs.statSync(archivePath);
                    const saved = db.prepare('SELECT design_hash, source_hash, archive_size, archive_mtime FROM chapter_cover_insertions WHERE archive_path=?').get(archivePath);
                    const expectedHash = chapterDesignHash(sourceHash, design, chapter);
                    current = Boolean(saved && saved.design_hash === expectedHash && saved.source_hash === sourceHash
                        && Number(saved.archive_size) === stat.size && Number(saved.archive_mtime) === Math.floor(stat.mtimeMs));
                }
            } catch (_) {}
        }
        if (current) alreadyCurrent++;
        else pending.push(archivePath);
    }
    const transaction = db.transaction(() => {
        const nowValue = new Date().toISOString();
        supersedeCoverJobsForSeries(target.value, 'generated');
        db.prepare("UPDATE chapter_cover_jobs SET status='superseded', updated_at=?, finished_at=?, error='Superseded by a newer generated-cover rule for this manga.' WHERE lower(series)=lower(?) AND status IN ('queued','running')")
            .run(nowValue, nowValue, target.value);
        db.prepare("UPDATE chapter_cover_job_items SET status='superseded' WHERE job_id IN (SELECT id FROM chapter_cover_jobs WHERE lower(series)=lower(?)) AND status='pending'")
            .run(target.value);
        db.prepare(`INSERT INTO chapter_cover_jobs (id, series, enabled, status, total, done, applied, skipped, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?)`)
            .run(id, target.value, enabled ? 1 : 0, chapters.length, alreadyCurrent, alreadyCurrent, nowValue, nowValue);
        for (const archivePath of pending) addItem.run(id, archivePath);
    });
    transaction();
    if (!pending.length) {
        db.prepare("UPDATE chapter_cover_jobs SET status='completed', finished_at=?, updated_at=? WHERE id=?").run(now, now, id);
    } else setImmediate(processChapterCoverJobs);
    log(`[CHAPTER COVER DESIGN] ${enabled ? 'Generating' : 'Removing generated'} chapter covers for ${target.value}: ${pending.length} queued; ${alreadyCurrent} unchanged.`);
    return { design: getChapterCoverDesign(target.value), job: getChapterCoverJobStatus(id) };
}

async function processChapterCoverJobs() {
    if (chapterCoverWorkerRunning) return;
    chapterCoverWorkerRunning = true;
    try {
        while (true) {
            if (pipelinePromise) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
            const job = db.prepare("SELECT * FROM chapter_cover_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1").get();
            if (!job) break;
            const activeJob = db.prepare('SELECT status FROM chapter_cover_jobs WHERE id=?').get(job.id);
            if (!activeJob || !['queued', 'running'].includes(activeJob.status)) continue;
            const design = getChapterCoverDesign(job.series);
            if (job.enabled && (!design || !design.enabled)) {
                const now = new Date().toISOString();
                db.prepare("UPDATE chapter_cover_jobs SET status='superseded', updated_at=?, finished_at=? WHERE id=?").run(now, now, job.id);
                continue;
            }
            db.prepare("UPDATE chapter_cover_jobs SET status='running', updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
            const item = db.prepare("SELECT * FROM chapter_cover_job_items WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1").get(job.id);
            if (!item) {
                const now = new Date().toISOString();
                db.prepare('UPDATE chapter_cover_jobs SET status=?, updated_at=?, finished_at=? WHERE id=?')
                    .run(job.errors ? 'completed_with_errors' : 'completed', now, now, job.id);
                continue;
            }
            if (pipelinePromise) continue;
            db.prepare("UPDATE chapter_cover_job_items SET status='running' WHERE id=?").run(item.id);
            try {
                beginCoverMutation();
                let result = { changed: false, skipped: true };
                if (await fs.pathExists(item.archive_path)) {
                    if (job.enabled) result = await applyChapterCoverDesignToFile(item.archive_path, job.series, design);
                    else result = await applyCoverRuleToFile(item.archive_path, job.series);
                }
                db.prepare("UPDATE chapter_cover_job_items SET status='done', error=NULL WHERE id=?").run(item.id);
                db.prepare('UPDATE chapter_cover_jobs SET done=done+1, applied=applied+?, skipped=skipped+?, updated_at=? WHERE id=?')
                    .run(result.changed ? 1 : 0, result.skipped ? 1 : 0, new Date().toISOString(), job.id);
            } catch (error) {
                db.prepare("UPDATE chapter_cover_job_items SET status='error', error=? WHERE id=?").run(error.message, item.id);
                db.prepare('UPDATE chapter_cover_jobs SET done=done+1, errors=errors+1, updated_at=?, error=? WHERE id=?')
                    .run(new Date().toISOString(), error.message.slice(0, 1000), job.id);
                log(`[CHAPTER COVER ERROR] ${path.basename(item.archive_path)}: ${error.message}`, 'WARN');
            } finally { endCoverMutation(); }
            await new Promise(resolve => setImmediate(resolve));
        }
    } finally {
        chapterCoverWorkerRunning = false;
        const pending = db.prepare("SELECT 1 FROM chapter_cover_jobs WHERE status IN ('queued','running') LIMIT 1").get();
        if (pending && !pipelinePromise) setImmediate(processChapterCoverJobs);
    }
}

function resumeChapterCoverJobs() {
    db.prepare("UPDATE chapter_cover_job_items SET status='pending' WHERE status='running'").run();
    db.prepare("UPDATE chapter_cover_jobs SET status='queued', updated_at=? WHERE status='running'").run(new Date().toISOString());
    const pending = db.prepare("SELECT 1 FROM chapter_cover_jobs WHERE status='queued' LIMIT 1").get();
    if (pending) setImmediate(processChapterCoverJobs);
    return Boolean(pending);
}

function readComicInfoTemplateStore() {
    try {
        const parsed = JSON.parse(String(getSetting('comicInfoSeriesTemplates', '{}') || '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
}

function getComicInfoTemplate(series = '') {
    const globalTemplate = String(getSetting('comicInfoGlobalTemplate', '') || '');
    const key = String(series || '').trim().toLocaleLowerCase();
    const store = readComicInfoTemplateStore();
    const matchingKey = Object.keys(store).find(name => name.toLocaleLowerCase() === key);
    return matchingKey && store[matchingKey] ? String(store[matchingKey]) : globalTemplate;
}

function getComicInfoTemplates() {
    return {
        globalTemplate: String(getSetting('comicInfoGlobalTemplate', '') || ''),
        defaultTemplate: comicInfoUtils.createDefaultTemplate(),
        seriesTemplates: readComicInfoTemplateStore(),
        availableFields: comicInfoUtils.FIELD_NAMES,
        policy: getComicInfoPolicy('')
    };
}

function saveComicInfoTemplate(series, xml) {
    const cleanXml = comicInfoUtils.validateComicInfoXml(xml);
    const name = String(series || '').trim();
    if (!name) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run('comicInfoGlobalTemplate', cleanXml);
        log('Saved the global ComicInfo.xml template.');
        return { success: true, scope: 'global' };
    }
    const valid = validateSeriesName(name);
    if (!valid.valid) throw new Error(valid.message);
    const store = readComicInfoTemplateStore();
    const existingKey = Object.keys(store).find(key => key.toLocaleLowerCase() === valid.value.toLocaleLowerCase());
    store[existingKey || valid.value] = cleanXml;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('comicInfoSeriesTemplates', JSON.stringify(store));
    log(`Saved a ComicInfo.xml template for ${valid.value}.`);
    return { success: true, scope: 'series', series: valid.value };
}

function getComicInfoPolicy(series = '') {
    const policy = String(getSetting('comicInfoPolicy', 'leave') || 'leave').trim().toLowerCase();
    if (['leave', 'update', 'remove', 'replace', 'upgrade'].includes(policy)) return policy;

    return 'leave';
}

async function listComicInfoSeries() {
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) return [];
    const entries = await fs.readdir(destRoot, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const folder = path.join(destRoot, entry.name);
        let count = 0;
        try {
            for await (const _file of walkCbzFiles(folder)) count++;
        } catch (_) {}
        rows.push({ series: entry.name, count });
    }
    return rows.sort((a, b) => a.series.localeCompare(b.series, undefined, { numeric: true, sensitivity: 'base' }));
}

function resolveComicInfoArchive(filePath) {
    const { destRoot } = getRoots();
    if (!destRoot) throw new Error('Configure the destination library path first.');
    const resolved = path.resolve(String(filePath || ''));
    if (!isWithin(destRoot, resolved) || samePath(destRoot, resolved) || path.extname(resolved).toLowerCase() !== '.cbz') {
        throw new Error('The selected archive is outside the configured library or is not a CBZ file.');
    }
    return resolved;
}

async function listComicInfoArchives(series) {
    const valid = validateSeriesName(series);
    if (!valid.valid) throw new Error(valid.message);
    const { destRoot } = getRoots();
    const folder = path.resolve(destRoot || '', valid.value);
    if (!destRoot || !isWithin(destRoot, folder) || samePath(destRoot, folder)) throw new Error('Invalid library series folder.');
    if (!(await fs.pathExists(folder))) throw new Error('The selected manga folder does not exist.');
    const archives = [];
    for await (const filePath of walkCbzFiles(folder)) {
        const relative = path.relative(folder, filePath).split(path.sep).join('/');
        archives.push({ name: relative, path: filePath });
    }
    return archives.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function getComicInfoArchive(filePath) {
    const resolved = resolveComicInfoArchive(filePath);
    const result = await zip.readComicInfoText(resolved);
    return { path: resolved, exists: result.exists, xml: result.xml, entryName: result.entryName };
}

function getComicInfoChapterContext(filePath, series = '', parsedOverride = null) {
    const parsed = parsedOverride || parseSeriesChapter(path.basename(String(filePath || '')), series);
    return buildComicInfoChapterContext(filePath, series, parsed);
}

async function previewComicInfoTemplateForArchive(filePath, templateXml) {
    const resolved = resolveComicInfoArchive(filePath);
    const series = seriesNameFromPath(resolved, getRoots().destRoot);
    const context = getComicInfoChapterContext(resolved, series);
    const template = comicInfoUtils.validateComicInfoXml(templateXml);
    return {
        path: resolved,
        series,
        chapter: context,
        xml: comicInfoUtils.validateComicInfoXml(comicInfoUtils.renderComicInfoTemplate(template, context))
    };
}

async function saveComicInfoArchive(filePath, xml) {
    const resolved = resolveComicInfoArchive(filePath);
    const cleanXml = comicInfoUtils.validateComicInfoXml(xml);
    const before = await zip.readComicInfoText(resolved);
    if (before.exists && before.xml.trim() === cleanXml.trim()) return { success: true, changed: false, message: 'ComicInfo.xml is already up to date.' };
    const series = seriesNameFromPath(resolved, getRoots().destRoot);
    const snapshot = await createRecoverySnapshotForPath(resolved, series);
    const result = await zip.writeComicInfoInPlace(resolved, cleanXml);
    const stats = await fs.stat(resolved);
    db.prepare('DELETE FROM processed_files WHERE path=?').run(path.resolve(resolved));
    log(`[COMICINFO EDIT] Updated ${path.basename(resolved)}${snapshot ? `; original saved to Recovery #${snapshot.id}` : ''}.`);
    return { success: true, changed: true, recoveryId: snapshot?.id || null, message: 'ComicInfo.xml saved. The original CBZ was copied to Recovery before editing.', result };
}

async function applyComicInfoPolicyToSeries(series, policyInput = '') {
    const valid = validateSeriesName(series);
    if (!valid.valid) throw new Error(valid.message);
    const policy = String(policyInput || getComicInfoPolicy(valid.value)).trim().toLowerCase();
    if (!['leave', 'update', 'remove', 'replace', 'upgrade'].includes(policy)) throw new Error('Choose a valid ComicInfo policy.');
    if (policy === 'leave') return { success: true, policy, scanned: 0, changed: 0, skipped: 0, message: 'Leave alone is selected; no files were changed.' };
    const template = policy === 'replace' || policy === 'upgrade' ? getComicInfoTemplate(valid.value) : '';
    if ((policy === 'replace' || policy === 'upgrade') && !template) throw new Error('Save a global or series-specific ComicInfo.xml template before applying this policy.')
    const files = await listComicInfoArchives(valid.value);
    let changed = 0, skipped = 0, errors = 0;
    let attentionFailures = 0;
    for (const item of files) {
        try {
            const current = await zip.readComicInfoText(item.path);
            let nextXml = '';
            if (policy === 'remove') {
                if (!current.exists) { skipped++; continue; }
            } else if (policy === 'update') {
                if (!current.exists) { skipped++; continue; }
                nextXml = comicInfoUtils.updateComicInfoIdentity(current.xml, getComicInfoChapterContext(item.path, valid.value));
                if (current.xml.trim() === nextXml.trim()) { skipped++; continue; }
            } else {
                const chapterTemplate = comicInfoUtils.renderComicInfoTemplate(template, getComicInfoChapterContext(item.path, valid.value));
                if (policy === 'replace') nextXml = comicInfoUtils.validateComicInfoXml(chapterTemplate);
                else if (current.exists) nextXml = comicInfoUtils.upgradeComicInfoXml(current.xml, chapterTemplate);
                else nextXml = comicInfoUtils.validateComicInfoXml(chapterTemplate);
                if (current.exists && current.xml.trim() === nextXml.trim()) { skipped++; continue; }
            }
            await createRecoverySnapshotForPath(item.path, valid.value);
            if (policy === 'remove') await zip.removeComicInfoInPlace(item.path);
            else await zip.writeComicInfoInPlace(item.path, nextXml);
            db.prepare('DELETE FROM processed_files WHERE path=?').run(path.resolve(item.path));
            changed++;
        } catch (error) {
            errors++;
            const stats = await fs.stat(item.path).catch(() => null);
            if (stats) {
                recordFileIssue(item.path, 'xml_cleanup_failed', `ComicInfo ${policy} policy failed: ${error.message}`, stats);
                attentionFailures++;
            }
            log(`[COMICINFO ${policy.toUpperCase()} FAILED] ${path.basename(item.path)}: ${error.message}. Added to Files Needing Attention when the file remains accessible.`, 'ERROR');
        }
    }
    log(`[COMICINFO ${policy.toUpperCase()}] ${valid.value}: scanned ${files.length}; changed ${changed}; unchanged ${skipped}; errors ${errors}; sent to Attention ${attentionFailures}.`);
    if (changed || errors) sendNotification(`ComicInfo ${policy} policy for ${valid.value}: ${changed} changed, ${skipped} unchanged, ${errors} failed.`, { event: 'qc' }).catch(() => {});
    return { success: true, policy, series: valid.value, scanned: files.length, changed, skipped, errors, attentionFailures };
}

async function applyComicInfoPolicyToReviewFile(filePath, seriesOverride = '') {
    const resolved = path.resolve(String(filePath || ''));
    const { sourceRoot, destRoot } = getRoots();
    const inDestination = Boolean(destRoot && isWithin(destRoot, resolved) && !samePath(destRoot, resolved));
    const inSource = Boolean(sourceRoot && isWithin(sourceRoot, resolved) && !samePath(sourceRoot, resolved));
    if (!inDestination && !inSource) {
        throw new Error('The CBZ is outside the configured download and manga-library folders.');
    }
    if (path.extname(resolved).toLowerCase() !== '.cbz') throw new Error('The selected file is not a CBZ archive.');

    const inferredSeries = inDestination
        ? seriesNameFromPath(resolved, destRoot)
        : String(seriesOverride || inferSeriesForFilePath(resolved) || '').trim();
    const requestedSeries = String(inDestination ? inferredSeries : (seriesOverride || inferredSeries || '')).trim();
    const validation = validateSeriesName(requestedSeries);
    if (!validation.valid) throw new Error(`Could not identify the manga for this file: ${validation.message}`);
    const series = validation.value;
    const policy = getComicInfoPolicy(series);
    const result = await applyComicInfoPolicyToIncoming(resolved, series);
    if (result.missingTemplate) {
        throw new Error(`The saved ComicInfo policy is ${policy}, but no global or manga-specific template is available. Save a template before retrying this file.`);
    }

    if (inDestination) {
        const stats = await fs.stat(resolved);
        updateProcessedFile(resolved, stats);
    }
    if (result.changed) {
        log(`[COMICINFO ${policy.toUpperCase()} RECHECK] Applied the saved policy to ${path.basename(resolved)}${result.recoveryId ? `; original saved to Recovery #${result.recoveryId}` : ''}.`);
    }
    return {
        ...result,
        success: true,
        policy,
        message: result.changed
            ? `Applied the saved ${policy.charAt(0).toUpperCase() + policy.slice(1)} policy. The original library CBZ was preserved in Recovery before the metadata change when applicable.`
            : `The saved ${policy.charAt(0).toUpperCase() + policy.slice(1)} policy is already satisfied. No XML changes were needed.`
    };
}

async function applyComicInfoPolicyToArchive(filePath) {
    const resolved = resolveComicInfoArchive(filePath);
    return applyComicInfoPolicyToReviewFile(resolved);
}

async function fetchComicInfoKavitaMetadata(series) {
    const match = await findKavitaSeriesMatch(series);
    if (!match.match || match.ambiguous) return { matched: false, ambiguous: Boolean(match.ambiguous), suggestions: match.suggestions || [] };
    const result = { matched: true, id: match.match.id, name: match.match.name, originalName: match.match.originalName || match.match.name, localizedName: match.match.localizedName || '', metadata: { Series: match.match.originalName || match.match.name } };
    if (match.match.localizedName && match.match.localizedName !== (match.match.originalName || match.match.name)) result.metadata.LocalizedSeries = match.match.localizedName;
    try {

        const metadata = await kavitaApiRequest(`/api/Series/metadata?seriesId=${encodeURIComponent(match.match.id)}`) || {};
        const listNames = value => Array.isArray(value)
            ? value.map(item => typeof item === 'string' ? item : item?.name || item?.title || '').map(value => String(value).trim()).filter(Boolean).join(', ')
            : '';
        const fields = {
            Summary: metadata.summary,
            Series: match.match.name,
            Genre: listNames(metadata.genres),
            Tags: listNames(metadata.tags),
            Writer: listNames(metadata.writers),
            CoverArtist: listNames(metadata.coverArtists),
            Publisher: listNames(metadata.publishers),
            Imprint: listNames(metadata.imprints),
            Characters: listNames(metadata.characters),
            Penciller: listNames(metadata.pencillers),
            Inker: listNames(metadata.inkers),
            Colorist: listNames(metadata.colorists),
            Letterer: listNames(metadata.letterers),
            Editor: listNames(metadata.editors),
            Translator: listNames(metadata.translators),
            Teams: listNames(metadata.teams),
            Locations: listNames(metadata.locations),
            Year: metadata.releaseYear,
            LanguageISO: metadata.language,
            Web: metadata.webLinks,
            Count: metadata.totalCount
        };
        for (const [field, value] of Object.entries(fields)) {
            if (value == null || value === '' || (typeof value === 'number' && (!Number.isFinite(value) || value <= 0))) continue;
            const normalized = String(value).trim();
            if (normalized) result.metadata[field] = normalized;
        }
        if (metadata.ageRating != null && metadata.ageRating !== '') {
            if (typeof metadata.ageRating === 'string' && !/^\d+$/.test(metadata.ageRating)) {
                result.metadata.AgeRating = metadata.ageRating;
            } else if (Number.isFinite(Number(metadata.ageRating))) {
                try {
                    const rating = await kavitaApiRequest(`/api/Series/age-rating?ageRating=${encodeURIComponent(metadata.ageRating)}`);
                    const label = String(rating || '').trim().replace(/^"|"$/g, '');
                    if (label) result.metadata.AgeRating = label;
                } catch (error) {
                    log(`[KAVITA COMICINFO] Could not translate the age rating for ${match.match.name}: ${error.message}`, 'WARN');
                }
            }
        }
    } catch (error) {
        log(`[KAVITA COMICINFO] Could not load full metadata for ${match.match.name}; using the Kavita series title only. ${error.message}`, 'WARN');
    }
    return result;
}

async function listCoverSeries() {
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) throw new Error('The configured manga library is not accessible. Check Settings → Test Paths.');
    const entries = await fs.readdir(destRoot, { withFileTypes: true });
    const folders = entries.filter(entry => entry.isDirectory() && isLibrarySeriesFolderName(entry.name))
        .map(entry => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const results = [];
    for (const series of folders) {
        const seriesPath = path.join(destRoot, series);
        const [candidates, files, rule] = await Promise.all([
            listSeriesCoverCandidates(seriesPath),
            fs.readdir(seriesPath, { withFileTypes: true }),
            Promise.resolve(getCoverRule(series))
        ]);
        const chapters = files.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz').length;
        const trackedCoverCount = Number(db.prepare('SELECT COUNT(*) AS count FROM cover_insertions WHERE lower(series)=lower(?)').get(series)?.count || 0)
            + Number(db.prepare('SELECT COUNT(*) AS count FROM chapter_cover_insertions WHERE lower(series)=lower(?)').get(series)?.count || 0)
;
        const chapterDesign = getChapterCoverDesign(series);
        const kavitaCoverSource = getSeriesKavitaCoverSource(series);
        const generatedCoverCount = Number(db.prepare('SELECT COUNT(*) AS count FROM chapter_cover_insertions WHERE lower(series)=lower(?)').get(series)?.count || 0);
        results.push({
            series,
            chapterCount: chapters,
            trackedCoverCount,
            generatedCoverCount,
            chapterDesign,
            generatedCoverEnabled: Boolean(chapterDesign?.enabled),
            kavitaCoverSource,
            autoCoverEnabled: Boolean(kavitaCoverSource?.autoCoverEnabled),
            enabled: Boolean(rule?.enabled),
            coverPath: rule?.cover_path || '',
            selectedCover: rule?.cover_path || candidates.find(item => item.rank < 99)?.path || '',
            defaultCover: candidates.find(item => item.rank < 99)?.path || '',
            coverLabel: candidates.find(item => item.rank < 99)?.name || '',
            hasCover: candidates.length > 0,
            coverCandidates: candidates.map(item => ({ name: item.name, path: item.path, type: coverCandidateType(item) })),
            lastUpdated: rule?.updated_at || null,
            job: getLatestCoverJob(series)
        });
    }
    return results;
}

function getLatestCoverJob(series) {
    const row = db.prepare('SELECT * FROM cover_update_jobs WHERE lower(series)=lower(?) ORDER BY created_at DESC LIMIT 1').get(String(series || ''));
    return row ? formatCoverJob(row) : null;
}

function formatCoverJob(row) {
    return {
        id: row.id, series: row.series, enabled: Boolean(row.enabled), status: row.status,
        total: row.total, done: row.done, applied: row.applied, skipped: row.skipped,
        errors: row.errors, createdAt: row.created_at, updatedAt: row.updated_at,
        finishedAt: row.finished_at, error: row.error
    };
}

async function getCoverPreview(series, chapterName = '', coverPathOverride = '', usePreferredCover = false) {
    const { destRoot } = getRoots();
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const seriesPath = path.resolve(destRoot, target.value);
    if (!destRoot || !isWithin(destRoot, seriesPath) || !(await fs.pathExists(seriesPath))) throw new Error('Manga series folder was not found in the library.');
    const [candidates, entries] = await Promise.all([
        listSeriesCoverCandidates(seriesPath),
        fs.readdir(seriesPath, { withFileTypes: true })
    ]);
    const chapters = entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz')
        .map(entry => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const selectedChapter = chapters.includes(chapterName) ? chapterName : (chapters[0] || '');
    const rule = getCoverRule(target.value);

    const storedCoverPath = String(rule?.cover_path || '').trim();
    const savedCoverPath = candidates.find(item => storedCoverPath && samePath(item.path, storedCoverPath))?.path || '';
    const explicitCoverPath = String(coverPathOverride || '').trim();
    const requestedCoverPath = usePreferredCover ? '' : (explicitCoverPath || savedCoverPath);
    const automaticCover = candidates.find(item => item.rank < 99)?.path || null;
    let coverPath = automaticCover;
    if (requestedCoverPath) {
        try { coverPath = await resolveSeriesCoverPath(seriesPath, requestedCoverPath); }
        catch (error) {

            if (explicitCoverPath) throw error;
        }
    }
    let chapterPages = [];
    if (selectedChapter) {
        const chapterPath = path.resolve(seriesPath, selectedChapter);
        if (!isWithin(seriesPath, chapterPath) || path.dirname(chapterPath) !== seriesPath) throw new Error('Invalid chapter preview path.');
        const directory = await zip.readZipDirectory(chapterPath);
        chapterPages = zip.imageEntries(directory).slice(0, 4).map(entry => ({ index: entry.index, name: entry.name }));
    }
    return {
        series: target.value,
        enabled: Boolean(rule?.enabled),
        coverPath: coverPath || '',
        selectedCover: requestedCoverPath || '',
        savedCoverPath,
        candidates: candidates.map(item => ({ name: item.name, path: item.path, type: coverCandidateType(item) })),
        chapters,
        selectedChapter,
        chapterPages,
        job: getLatestCoverJob(target.value)
    };
}

async function getCoverPreviewCandidate(series, candidatePath) {
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot, series);
    const resolved = path.resolve(candidatePath);
    if (!destRoot || !isWithin(destRoot, seriesPath) || !isWithin(seriesPath, resolved) || !COVER_EXT_PATTERN.test(path.basename(resolved))) {
        throw new Error('Cover preview path is invalid.');
    }
    const candidates = await listSeriesCoverCandidates(seriesPath);
    const match = candidates.find(item => samePath(item.path, resolved));
    if (!match) throw new Error('Cover image is no longer available. Refresh the preview.');
    return match.path;
}

async function getCoverPreviewPage(series, chapterName, pageIndex) {
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot, series);
    const chapterPath = path.resolve(seriesPath, path.basename(String(chapterName || '')));
    if (!destRoot || !isWithin(destRoot, seriesPath) || !isWithin(seriesPath, chapterPath) || path.dirname(chapterPath) !== seriesPath || path.extname(chapterPath).toLowerCase() !== '.cbz') {
        throw new Error('Chapter preview path is invalid.');
    }
    const directory = await zip.readZipDirectory(chapterPath);
    const index = Number.parseInt(pageIndex, 10);
    const entry = zip.imageEntries(directory).find(item => item.index === index);
    if (!entry) throw new Error('Chapter preview page was not found.');
    return { archivePath: chapterPath, entry, mimeType: zip.mimeTypeForImage(entry.name) };
}

function renameSeriesCoverRule(oldName, newName) {
    if (!oldName || !newName || oldName.toLowerCase() === newName.toLowerCase()) return;
    const oldRule = db.prepare('SELECT * FROM series_cover_rules WHERE lower(target_series)=lower(?)').get(oldName);
    const { destRoot } = getRoots();
    const oldSeriesPath = destRoot ? path.resolve(destRoot, oldName) : '';
    const newSeriesPath = destRoot ? path.resolve(destRoot, newName) : '';
    const now = new Date().toISOString();

    if (oldRule) {
        let migratedCoverPath = oldRule.cover_path || '';
        if (migratedCoverPath && oldSeriesPath && samePath(path.dirname(path.resolve(migratedCoverPath)), oldSeriesPath)) {
            migratedCoverPath = path.join(newSeriesPath, path.basename(migratedCoverPath));
        }
        const existing = getCoverRule(newName);
        if (!existing) {
            db.prepare('UPDATE series_cover_rules SET target_series=?, cover_path=?, updated_at=? WHERE target_series=?')
                .run(newName, migratedCoverPath, now, oldRule.target_series);
        } else {
            db.prepare('DELETE FROM series_cover_rules WHERE target_series=?').run(oldRule.target_series);
        }
    }

    const oldKavitaSource = db.prepare('SELECT * FROM series_kavita_cover_sources WHERE lower(target_series)=lower(?)').get(oldName);
    if (oldKavitaSource) {
        const targetSource = db.prepare('SELECT 1 FROM series_kavita_cover_sources WHERE lower(target_series)=lower(?)').get(newName);
        if (targetSource) db.prepare('DELETE FROM series_kavita_cover_sources WHERE target_series=?').run(oldKavitaSource.target_series);
        else db.prepare('UPDATE series_kavita_cover_sources SET target_series=?, updated_at=? WHERE target_series=?')
            .run(newName, now, oldKavitaSource.target_series);
    }

    db.prepare("UPDATE cover_update_jobs SET status='superseded', updated_at=?, finished_at=? WHERE lower(series)=lower(?) AND status IN ('queued','running')")
        .run(now, now, oldName);
    db.prepare('UPDATE cover_update_jobs SET series=? WHERE lower(series)=lower(?)').run(newName, oldName);

    const oldDesign = db.prepare('SELECT * FROM series_chapter_cover_designs WHERE lower(target_series)=lower(?)').get(oldName);
    if (oldDesign) {
        let sourcePath = oldDesign.source_path || '';
        if (sourcePath && oldSeriesPath && newSeriesPath && isWithin(oldSeriesPath, sourcePath)) sourcePath = path.join(newSeriesPath, path.relative(oldSeriesPath, sourcePath));
        const currentDesign = db.prepare('SELECT 1 FROM series_chapter_cover_designs WHERE lower(target_series)=lower(?)').get(newName);
        if (currentDesign) db.prepare('DELETE FROM series_chapter_cover_designs WHERE target_series=?').run(oldDesign.target_series);
        else db.prepare('UPDATE series_chapter_cover_designs SET target_series=?, source_path=?, updated_at=? WHERE target_series=?')
            .run(newName, sourcePath, now, oldDesign.target_series);
    }
    db.prepare('UPDATE chapter_cover_insertions SET series=? WHERE lower(series)=lower(?)').run(newName, oldName);
    db.prepare('UPDATE chapter_cover_jobs SET series=? WHERE lower(series)=lower(?)').run(newName, oldName);

    const insertionRows = db.prepare('SELECT archive_path FROM cover_insertions WHERE lower(series)=lower(?)').all(oldName);
    for (const row of insertionRows) {
        let archivePath = row.archive_path;
        if (oldSeriesPath && newSeriesPath && isWithin(oldSeriesPath, archivePath)) {
            archivePath = path.join(newSeriesPath, path.relative(oldSeriesPath, archivePath));
        }
        db.prepare('UPDATE cover_insertions SET series=?, archive_path=? WHERE archive_path=?').run(newName, archivePath, row.archive_path);
    }
}

function startCoverUpdateJob(series, enabled, coverPath = '') {
    const target = validateSeriesName(series);
    if (!target.valid) throw new Error(target.message);
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot, target.value);
    if (!destRoot || !isWithin(destRoot, seriesPath) || !fs.existsSync(seriesPath)) throw new Error('The selected manga folder is not accessible.');
    const selected = String(coverPath || '').trim();
    let effectiveCoverPath = '';
    let effectiveCoverHash = '';
    if (enabled) {
        if (selected) {
            const resolved = path.resolve(selected);
            if (!isWithin(seriesPath, resolved) || samePath(seriesPath, resolved) || !COVER_EXT_PATTERN.test(path.basename(resolved)) || !fs.existsSync(resolved)) {
                throw new Error('Select an available cover image from this manga folder.');
            }
            effectiveCoverPath = resolved;
        } else {
            const candidates = fs.readdirSync(seriesPath, { withFileTypes: true })
                .filter(entry => entry.isFile() && COVER_EXT_PATTERN.test(entry.name))
                .map(entry => ({ path: path.join(seriesPath, entry.name), name: entry.name, rank: coverCandidateRank(entry.name) }))
                .sort(compareCoverCandidates);
            effectiveCoverPath = candidates.find(entry => entry.rank < 99)?.path || '';
            if (!effectiveCoverPath) throw new Error('No automatic cover image was found. Add c-cover, cover, folder, or poster image, or choose another image from the series folder.');
        }

        effectiveCoverHash = crypto.createHash('sha256').update(fs.readFileSync(effectiveCoverPath)).digest('hex');
    }

    const chapters = fs.readdirSync(seriesPath, { withFileTypes: true }).filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz')
        .map(entry => path.resolve(seriesPath, entry.name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    const add = db.prepare("INSERT INTO cover_update_items (job_id, archive_path, status) VALUES (?, ?, 'pending')");
    let alreadyCurrent = 0;
    const pendingChapters = [];
    for (const chapter of chapters) {
        let upToDate = false;
        if (enabled) {
            try {
                const stat = fs.statSync(chapter);
                const applied = db.prepare('SELECT cover_path, cover_hash, archive_size, archive_mtime FROM cover_insertions WHERE archive_path=?').get(chapter);
                upToDate = Boolean(applied && samePath(applied.cover_path, effectiveCoverPath) && applied.cover_hash === effectiveCoverHash
                    && Number(applied.archive_size) === stat.size && Number(applied.archive_mtime) === Math.floor(stat.mtimeMs));
            } catch (_) {}
        }
        if (upToDate) alreadyCurrent++;
        else pendingChapters.push(chapter);
    }

    const transaction = db.transaction(() => {
        supersedeCoverJobsForSeries(target.value, 'static');
        db.prepare("UPDATE cover_update_jobs SET status='superseded', updated_at=?, finished_at=?, error='Superseded by a newer static cover rule for this manga.' WHERE lower(series)=lower(?) AND status IN ('queued','running')")
            .run(now, now, target.value);
        db.prepare("UPDATE cover_update_items SET status='superseded' WHERE job_id IN (SELECT id FROM cover_update_jobs WHERE lower(series)=lower(?)) AND status='pending'")
            .run(target.value);
        db.prepare(`INSERT INTO cover_update_jobs (id, series, enabled, cover_path, status, total, done, skipped, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
            .run(id, target.value, enabled ? 1 : 0, selected, chapters.length, alreadyCurrent, alreadyCurrent, now, now);
        for (const chapter of pendingChapters) add.run(id, chapter);
        db.prepare(`INSERT INTO series_cover_rules (target_series, enabled, cover_path, last_job_id, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(target_series) DO UPDATE SET enabled=excluded.enabled,
            cover_path=excluded.cover_path, last_job_id=excluded.last_job_id, updated_at=excluded.updated_at`)
            .run(target.value, enabled ? 1 : 0, selected, id, now);
    });
    transaction();
    if (!chapters.length) {
        db.prepare("UPDATE cover_update_jobs SET status='completed', finished_at=?, updated_at=? WHERE id=?").run(now, now, id);
    } else {
        setImmediate(processCoverJobs);
    }
    log(`[COVER JOB] ${enabled ? 'Applying' : 'Removing'} managed cover image for ${target.value}: ${pendingChapters.length} chapter(s) queued; ${alreadyCurrent} already up to date.`);
    return getCoverJobStatus(id);
}

function formatKavitaAutoCoverBulkJob(row) {
    if (!row) return null;
    let results = [];
    try { results = JSON.parse(row.results_json || '[]'); } catch (_) {}
    return {
        id: row.id, action: row.action, status: row.status, total: Number(row.total || 0),
        done: Number(row.done || 0), succeeded: Number(row.succeeded || 0),
        skipped: Number(row.skipped || 0), errors: Number(row.errors || 0),
        cancelRequested: Boolean(row.cancel_requested), results,
        createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at, error: row.error || ''
    };
}

function getKavitaAutoCoverBulkJob(id) {
    return formatKavitaAutoCoverBulkJob(db.prepare('SELECT * FROM kavita_auto_cover_bulk_jobs WHERE id=?').get(String(id || '')));
}

function startKavitaAutoCoverBulkJob(seriesNames, action) {
    const acceptedActions = new Set(['enable', 'refresh', 'disable']);
    const operation = String(action || '').toLowerCase();
    if (!acceptedActions.has(operation)) throw new Error('Choose Enable Auto Cover, Refresh Auto Cover, or Disable Auto Cover.');
    const names = [...new Set((Array.isArray(seriesNames) ? seriesNames : []).map(value => validateSeriesName(value)).filter(value => value.valid).map(value => value.value))];
    if (!names.length) throw new Error('Select at least one manga.');
    if (names.length > 500) throw new Error('Bulk cover actions are limited to 500 manga per batch.');
    const { destRoot } = getRoots();
    for (const name of names) {
        const seriesPath = path.resolve(destRoot || '', name);
        if (!destRoot || !isWithin(destRoot, seriesPath) || samePath(destRoot, seriesPath) || !fs.existsSync(seriesPath) || !fs.statSync(seriesPath).isDirectory()) {
            throw new Error(`The manga folder is unavailable: ${name}`);
        }
    }
    const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO kavita_auto_cover_bulk_jobs
        (id, action, series_json, results_json, status, total, done, succeeded, skipped, errors, cancel_requested, created_at, updated_at)
        VALUES (?, ?, ?, '[]', 'queued', ?, 0, 0, 0, 0, 0, ?, ?)`)
        .run(id, operation, JSON.stringify(names), names.length, now, now);
    setImmediate(processKavitaAutoCoverBulkJobs);
    log(`[KAVITA AUTO COVER BULK] Queued ${operation} for ${names.length} manga.`);
    return getKavitaAutoCoverBulkJob(id);
}

async function processKavitaAutoCoverBulkJobs() {
    if (kavitaAutoCoverBulkWorkerRunning) return;
    kavitaAutoCoverBulkWorkerRunning = true;
    try {
        while (true) {
            const job = db.prepare("SELECT * FROM kavita_auto_cover_bulk_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1").get();
            if (!job) break;
            db.prepare("UPDATE kavita_auto_cover_bulk_jobs SET status='running', updated_at=? WHERE id=? AND status='queued'")
                .run(new Date().toISOString(), job.id);
            let names = [];
            let results = [];
            try { names = JSON.parse(job.series_json || '[]'); } catch (_) {}
            try { results = JSON.parse(job.results_json || '[]'); } catch (_) {}
            for (const series of names.slice(Number(job.done || 0))) {
                const current = db.prepare('SELECT cancel_requested, status FROM kavita_auto_cover_bulk_jobs WHERE id=?').get(job.id);
                if (!current || current.status === 'cancelled' || current.cancel_requested) break;
                let outcome = { series, status: 'success', message: '' };
                try {
                    const source = getSeriesKavitaCoverSource(series);
                    if (job.action === 'enable') {
                        const rule = getCoverRule(series);
                        const result = await saveChapterCoverSettings(series, {
                            staticEnabled: Boolean(rule?.enabled),
                            coverPath: rule?.cover_path || '',
                            autoCoverEnabled: true
                        });
                        outcome.message = result.message;
                    } else if (job.action === 'refresh') {
                        if (!source?.autoCoverEnabled || !source?.kavitaSeriesId) {
                            outcome.status = 'skipped';
                            outcome.message = 'Auto Cover is not enabled or no Kavita series is linked.';
                        } else {
                            const result = await setKavitaAutoCover(series, true, true, source.kavitaSeriesId, source.kavitaSeriesName);
                            outcome.message = result.message;
                        }
                    } else if (job.action === 'disable') {
                        if (!source?.autoCoverEnabled) {
                            outcome.status = 'skipped';
                            outcome.message = 'Auto Cover is already disabled.';
                        } else {
                            const rule = getCoverRule(series);
                            const result = await saveChapterCoverSettings(series, {
                                staticEnabled: Boolean(rule?.enabled),
                                coverPath: rule?.cover_path || '',
                                autoCoverEnabled: false
                            });
                            outcome.message = result.message;
                        }
                    }
                } catch (error) {
                    outcome.status = 'error';
                    outcome.message = String(error.message || error).slice(0, 1000);
                }
                results.push(outcome);
                const succeeded = results.filter(item => item.status === 'success').length;
                const skipped = results.filter(item => item.status === 'skipped').length;
                const errors = results.filter(item => item.status === 'error').length;
                const done = results.length;
                db.prepare(`UPDATE kavita_auto_cover_bulk_jobs SET results_json=?, done=?, succeeded=?, skipped=?, errors=?, updated_at=? WHERE id=?`)
                    .run(JSON.stringify(results), done, succeeded, skipped, errors, new Date().toISOString(), job.id);
                await new Promise(resolve => setImmediate(resolve));
            }
            const latest = db.prepare('SELECT * FROM kavita_auto_cover_bulk_jobs WHERE id=?').get(job.id);
            if (!latest) continue;
            const finalStatus = latest.cancel_requested ? 'cancelled' : Number(latest.done) >= Number(latest.total)
                ? (Number(latest.errors) ? 'completed_with_errors' : 'completed') : 'cancelled';
            const now = new Date().toISOString();
            db.prepare('UPDATE kavita_auto_cover_bulk_jobs SET status=?, updated_at=?, finished_at=? WHERE id=?')
                .run(finalStatus, now, now, job.id);
        }
    } finally {
        kavitaAutoCoverBulkWorkerRunning = false;
        const pending = db.prepare("SELECT 1 FROM kavita_auto_cover_bulk_jobs WHERE status='queued' LIMIT 1").get();
        if (pending) setImmediate(processKavitaAutoCoverBulkJobs);
    }
}

function cancelKavitaAutoCoverBulkJob(id) {
    const existing = db.prepare('SELECT status FROM kavita_auto_cover_bulk_jobs WHERE id=?').get(String(id || ''));
    if (!existing) throw new Error('Bulk cover job not found.');
    if (!['queued', 'running'].includes(existing.status)) return getKavitaAutoCoverBulkJob(id);
    db.prepare('UPDATE kavita_auto_cover_bulk_jobs SET cancel_requested=1, updated_at=? WHERE id=?')
        .run(new Date().toISOString(), String(id));
    return getKavitaAutoCoverBulkJob(id);
}

function resumeKavitaAutoCoverBulkJobs() {
    const pending = db.prepare("SELECT 1 FROM kavita_auto_cover_bulk_jobs WHERE status IN ('queued','running') LIMIT 1").get();
    if (pending) setImmediate(processKavitaAutoCoverBulkJobs);
    return Boolean(pending);
}

function getCoverJobStatus(id) {
    const row = db.prepare('SELECT * FROM cover_update_jobs WHERE id=?').get(String(id));
    return row ? formatCoverJob(row) : null;
}

async function processCoverJobs() {
    if (coverWorkerRunning) return;
    coverWorkerRunning = true;
    try {
        while (true) {
            if (pipelinePromise) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
            const job = db.prepare("SELECT * FROM cover_update_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1").get();
            if (!job) break;
            db.prepare("UPDATE cover_update_jobs SET status='running', updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
            const rule = getCoverRule(job.series);
            const isSuperseded = !rule || rule.last_job_id !== job.id;
            if (isSuperseded) {
                db.prepare("UPDATE cover_update_jobs SET status='superseded', updated_at=?, finished_at=? WHERE id=?")
                    .run(new Date().toISOString(), new Date().toISOString(), job.id);
                continue;
            }
            const item = db.prepare("SELECT * FROM cover_update_items WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1").get(job.id);
            if (!item) {
                const finalStatus = job.errors ? 'completed_with_errors' : 'completed';
                const now = new Date().toISOString();
                db.prepare('UPDATE cover_update_jobs SET status=?, updated_at=?, finished_at=? WHERE id=?').run(finalStatus, now, now, job.id);
                continue;
            }
            if (pipelinePromise) continue;
            db.prepare("UPDATE cover_update_items SET status='running' WHERE id=?").run(item.id);
            let result;
            try {
                beginCoverMutation();
                if (await fs.pathExists(item.archive_path)) result = await applyCoverRuleToFile(item.archive_path, job.series);
                else result = { changed: false, skipped: true };
                db.prepare("UPDATE cover_update_items SET status='done', error=NULL WHERE id=?").run(item.id);
                db.prepare(`UPDATE cover_update_jobs SET done=done+1, applied=applied+?, skipped=skipped+?, updated_at=? WHERE id=?`)
                    .run(result?.changed ? 1 : 0, result?.skipped ? 1 : 0, new Date().toISOString(), job.id);
            } catch (error) {
                db.prepare("UPDATE cover_update_items SET status='error', error=? WHERE id=?").run(error.message, item.id);
                db.prepare('UPDATE cover_update_jobs SET done=done+1, errors=errors+1, updated_at=?, error=? WHERE id=?')
                    .run(new Date().toISOString(), error.message.slice(0, 1000), job.id);
                log(`[COVER JOB ERROR] ${path.basename(item.archive_path)}: ${error.message}`, 'WARN');
            } finally {
                endCoverMutation();
            }
            await new Promise(resolve => setImmediate(resolve));
        }
    } finally {
        coverWorkerRunning = false;
        const pending = db.prepare("SELECT 1 FROM cover_update_jobs WHERE status IN ('queued','running') LIMIT 1").get();
        if (pending && !pipelinePromise) setImmediate(processCoverJobs);
    }
}

function resumeCoverUpdateJobs() {
    const now = new Date().toISOString();
    db.prepare("UPDATE cover_update_items SET status='pending' WHERE status='running'").run();
    db.prepare("UPDATE cover_update_jobs SET status='queued', updated_at=? WHERE status='running'").run(now);
    const pending = db.prepare("SELECT 1 FROM cover_update_jobs WHERE status='queued' LIMIT 1").get();
    if (pending) setImmediate(processCoverJobs);
    return Boolean(pending);
}

function validateSeriesName(name) {
    const clean = String(name || '').trim();
    if (!clean || clean === '.' || clean === '..') return { valid: false, message: 'Enter a valid series folder name.' };
    if (!isLibrarySeriesFolderName(clean)) return { valid: false, message: 'That name is reserved for PanelKeeper or filesystem metadata.' };
    if (/[\\/\0]/.test(clean)) return { valid: false, message: 'A series name cannot contain path separators.' };
    if (process.platform === 'win32' && /[<>:"|?*]/.test(clean)) {
        return { valid: false, message: 'This name contains a character Windows cannot use in a folder name.' };
    }
    if (/[\x00-\x1f]/.test(clean)) return { valid: false, message: 'A series name cannot contain control characters.' };
    return { valid: true, value: clean };
}

function rotateLogIfNeeded(nextLineLength) {
    const configuredMB = Number(getSetting('logFileMaxMB', '2'));
    const maxBytes = Number.isFinite(configuredMB) && configuredMB >= 1 ? Math.min(configuredMB, 25) * 1024 * 1024 : DEFAULT_LOG_FILE_MAX_BYTES;
    let size = 0;
    try { size = fs.statSync(LOG_PATH).size; } catch (_) {}
    if (size + nextLineLength <= maxBytes) return;

    const backupPath = `${LOG_PATH}.1`;
    try { fs.unlinkSync(backupPath); } catch (_) {}
    try { fs.renameSync(LOG_PATH, backupPath); } catch (error) {
        try { fs.writeFileSync(LOG_PATH, ''); } catch (_) {}
    }
}

function log(message, type = 'INFO') {
    const timestamp = nowLocal();
    const safeMessage = String(message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 4000);
    const line = `[${timestamp}] [${String(type).toUpperCase()}] ${safeMessage}`;
    console.log(line);

    try {
        db.prepare('INSERT INTO job_log (timestamp, message, type) VALUES (?, ?, ?)').run(timestamp, safeMessage, String(type).toUpperCase());
        logInsertCount++;
        if (logInsertCount >= 25) {
            logInsertCount = 0;
            const configuredRetention = Number(getSetting('logRetention', String(DEFAULT_LOG_RETENTION)));
            const keep = Number.isFinite(configuredRetention) ? Math.max(500, Math.min(50000, Math.floor(configuredRetention))) : DEFAULT_LOG_RETENTION;
            db.prepare('DELETE FROM job_log WHERE id NOT IN (SELECT id FROM job_log ORDER BY id DESC LIMIT ?)').run(keep);
        }
    } catch (error) {
        console.error('Failed to write database log:', error.message);
    }

    try {
        fs.ensureFileSync(LOG_PATH);
        rotateLogIfNeeded(Buffer.byteLength(line) + 1);
        fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
    } catch (error) {
        console.error('Failed to write log file:', error.message);
    }
}

async function sendNotification(message, options = {}) {
    const event = String(options.event || 'notification').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 60) || 'notification';
    const preferences = notificationUtils.readNotificationPreferences(getSetting);
    if (!notificationUtils.shouldSendEvent(event, preferences)) {
        return { sent: false, skipped: true, reason: `The ${event.replace(/_/g, ' ')} notification is disabled in Settings.` };
    }

    const url = String(getSetting('webhookUrl', '')).trim();
    if (!url) return { sent: false, reason: 'No Home Assistant webhook URL is configured.' };
    if (typeof fetch !== 'function') return { sent: false, reason: 'This Node.js runtime does not provide global fetch; use Node.js 20.9 or newer.' };

    let parsedUrl;
    try { parsedUrl = new URL(url); }
    catch (_) { return { sent: false, reason: 'The webhook URL is not a valid absolute URL. Use the full Home Assistant /api/webhook/<id> address.' }; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { sent: false, reason: 'The webhook URL must use http:// or https://.' };
    }
    const webhookMarker = '/api/webhook/';
    const webhookIndex = parsedUrl.pathname.indexOf(webhookMarker);
    const webhookId = webhookIndex >= 0 ? parsedUrl.pathname.slice(webhookIndex + webhookMarker.length).replace(/\/+$/g, '') : '';
    if (!webhookId || webhookId.includes('/')) {
        return { sent: false, reason: 'The URL must contain a complete Home Assistant webhook path: /api/webhook/<webhook_id>.' };
    }

    const testId = String(options.testId || crypto.randomUUID());
    const timestamp = new Date().toISOString();
    const finalMessage = options.details
        ? notificationUtils.buildPipelineMessage(event, options.details, preferences)
        : String(message || 'PanelKeeper notification.');
    const payload = notificationUtils.buildWebhookPayload(finalMessage, event, testId, timestamp, preferences);

    try {

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'PanelKeeper/1.10.31'
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(12000),
            redirect: 'follow'
        });
        const responseText = (await response.text().catch(() => '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
        if (!response.ok) {
            const detail = responseText ? ` Response: ${responseText}` : '';
            return { sent: false, status: response.status, host: parsedUrl.host, testId, reason: `Home Assistant returned HTTP ${response.status} ${response.statusText || ''}.${detail}`.trim() };
        }
        let finalUrl = null;
        try { finalUrl = new URL(response.url || url); } catch (_) {}
        if (response.redirected && (!finalUrl || !finalUrl.pathname.includes(webhookMarker))) {
            return {
                sent: false,
                status: response.status,
                host: parsedUrl.host,
                testId,
                reason: 'The request was redirected away from the Home Assistant webhook endpoint. Check the configured base URL, reverse-proxy path, and authentication redirect.'
            };
        }
        return { sent: true, httpResponded: true, automationConfirmed: false, status: response.status, host: parsedUrl.host, response: responseText, testId, payload };
    } catch (error) {
        const failure = webhookErrorUtils.classifyWebhookError(error);
        return {
            sent: false,
            host: parsedUrl.host,
            testId,
            code: failure.code,
            reason: `${failure.label}${failure.code ? ` (${failure.code})` : ''}: ${error.message}.${failure.hint}`
        };
    }
}

function archiveIssueKind(error) {
    return ['ZIP64_UNSUPPORTED', 'MULTIDISK_UNSUPPORTED', 'ZIP_DIRECTORY_TOO_LARGE'].includes(error?.code) ? 'unsupported_archive' : 'bad_archive';
}

function inferSeriesForFilePath(filePath) {
    const resolved = path.resolve(filePath);
    const { sourceRoot, destRoot } = getRoots();
    if (destRoot && isWithin(destRoot, resolved) && !samePath(destRoot, resolved)) {
        return seriesNameFromPath(resolved, destRoot);
    }
    if (sourceRoot && isWithin(sourceRoot, resolved)) {
        return findMappedTargetForSourceFile(resolved)?.target_series || '';
    }
    return '';
}

function recordFileIssue(filePath, kind, reason, stats) {
    const now = new Date().toISOString();
    const resolved = path.resolve(filePath);
    const size = stats?.size ?? 0;
    const mtime = stats?.mtimeMs ? Math.floor(stats.mtimeMs) : 0;
    const targetSeries = inferSeriesForFilePath(resolved);
    const wasPending = Boolean(db.prepare("SELECT 1 FROM file_issues WHERE path=? AND status='pending'").get(resolved));
    db.prepare(`
        INSERT INTO file_issues (path, kind, reason, target_series, size, mtime, created_at, updated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, reason=excluded.reason,
            target_series=excluded.target_series, size=excluded.size, mtime=excluded.mtime,
            updated_at=excluded.updated_at, status='pending'
    `).run(resolved, kind, String(reason).slice(0, 2000), targetSeries, size, mtime, now, now);
    if (!wasPending) {
        sendNotification(`PanelKeeper has a file that needs attention: ${path.basename(resolved)}${targetSeries ? ` (${targetSeries})` : ''}. Reason: ${String(reason).slice(0, 500)}`, { event: 'attention' }).catch(() => {});
    }
}

function resolveFileIssue(filePath) {
    db.prepare("UPDATE file_issues SET status='resolved', updated_at=? WHERE path=? AND status='pending'")
        .run(new Date().toISOString(), path.resolve(filePath));
}

function listCbzNames(entries) {
    return entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz')
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function normalizeSpecialTitle(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

async function listSeriesChapterFiles(seriesPath) {
    const files = [];
    const rootEntries = await fs.readdir(seriesPath, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of listCbzNames(rootEntries)) files.push(path.join(seriesPath, name));
    const specialsPath = path.join(seriesPath, 'Specials');
    const specialEntries = await fs.readdir(specialsPath, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of listCbzNames(specialEntries)) files.push(path.join(specialsPath, name));
    return files;
}

function assignSpecialNumber(series, seriesPath, chapter, { persist = true } = {}) {
    if (!chapter?.special) return chapter;
    const sourceKey = String(chapter.key || `special:${slugSpecialKey(chapter.specialTitle || chapter.label)}`);
    const title = String(chapter.specialTitle || chapter.additionalText || '').trim();
    const now = new Date().toISOString();
    const saved = db.prepare('SELECT special_number, special_title FROM series_special_numbers WHERE lower(series)=lower(?) AND special_key=?')
        .get(series, sourceKey);
    let number = Number(chapter.specialNumber || 0);
    if (!Number.isInteger(number) || number < 1) number = Number(saved?.special_number || 0);

    const used = new Set();
    let sameTitleNumber = null;
    if (!number) {
        const registry = db.prepare('SELECT special_number, special_title FROM series_special_numbers WHERE lower(series)=lower(?)').all(series);
        for (const row of registry) {
            if (Number(row.special_number) > 0) used.add(Number(row.special_number));
            if (title && normalizeSpecialTitle(row.special_title) === normalizeSpecialTitle(title)) sameTitleNumber = Number(row.special_number);
        }
        if (sameTitleNumber) number = sameTitleNumber;
    }
    if (!number && seriesPath && fs.existsSync(seriesPath)) {
        const candidates = [seriesPath, path.join(seriesPath, 'Specials')];
        for (const directory of candidates) {
            let entries = [];
            try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
            for (const entry of entries) {
                if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.cbz') continue;
                const parsed = parseSeriesChapter(entry.name, series);
                if (!parsed?.special || !Number.isInteger(Number(parsed.specialNumber)) || Number(parsed.specialNumber) < 1) continue;
                const existingNumber = Number(parsed.specialNumber);
                used.add(existingNumber);
                if (title && normalizeSpecialTitle(parsed.specialTitle || parsed.additionalText) === normalizeSpecialTitle(title)) sameTitleNumber = existingNumber;
            }
        }
        if (sameTitleNumber) number = sameTitleNumber;
    }
    if (!number) {
        number = 1;
        while (used.has(number)) number++;
    }
    if (!Number.isSafeInteger(number) || number < 1 || number > 9999) throw new Error('Special numbers must be from SP01 through SP9999.');

    if (persist) {
        db.prepare(`INSERT INTO series_special_numbers (series, special_key, special_number, special_title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(series, special_key) DO UPDATE SET special_number=excluded.special_number,
                special_title=excluded.special_title, updated_at=excluded.updated_at`)
            .run(series, sourceKey, number, title, now, now);
    }

    const displayNumber = String(number).padStart(2, '0');
    chapter.specialNumber = number;
    chapter.number = number;
    chapter.specialTitle = title;
    chapter.additionalText = title;
    chapter.key = `special:${number}`;
    chapter.label = title ? `Special ${displayNumber} - ${title}` : `Special ${displayNumber}`;
    chapter.special = true;
    return chapter;
}

function slugSpecialKey(value) {
    return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'untitled';
}

function buildChapterDestination(seriesPath, series, chapter, { persistSpecial = true } = {}) {
    if (chapter?.special) {
        assignSpecialNumber(series, seriesPath, chapter, { persist: persistSpecial });
        const specialsPath = path.join(seriesPath, 'Specials');
        const marker = `SP${String(chapter.specialNumber).padStart(2, '0')}`;
        const title = String(chapter.specialTitle || '').trim();
        const fileName = `${series} - ${marker}${title ? ` - ${title}` : ''}.cbz`;
        const targetPath = path.resolve(specialsPath, fileName);
        if (!isWithin(seriesPath, targetPath)) throw new Error('The Special destination escaped its manga folder.');
        return { directory: specialsPath, fileName, path: targetPath, chapter };
    }
    const volumePrefix = chapter?.volumeLabel ? `${chapter.volumeLabel} - ` : '';
    const archiveLabel = chapter?.isVolume || chapter?.volumeOnly
        ? (chapter.volumeLabel || chapter.label)
        : `${volumePrefix}${chapter.label}`;
    const fileName = `${series} - ${archiveLabel}.cbz`;
    const targetPath = path.resolve(seriesPath, fileName);
    if (!isWithin(seriesPath, targetPath)) throw new Error('The chapter destination escaped its manga folder.');
    return { directory: seriesPath, fileName, path: targetPath, chapter };
}

async function* walkCbzFiles(root, { onError = null } = {}) {
    if (!root || !(await fs.pathExists(root))) return;
    const skipNames = new Set(['node_modules', '.git', '$recycle.bin', '.hist', '.panelkeeper-recovery', '.panelkeeper-trash']);
    async function* visit(dir) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (onError) onError(dir, error);
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (skipNames.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.panelkeeper-')) continue;
                yield* visit(fullPath);
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz') {
                yield fullPath;
            }
        }
    }
    yield* visit(path.resolve(root));
}

async function discoverSourceSeries(sourceRoot, destRoot) {
    const results = [];
    const folderMode = ['auto', 'direct', 'nested'].includes(String(getSetting('sourceFolderMode', 'auto')))
        ? String(getSetting('sourceFolderMode', 'auto')) : 'auto';
    const skipNames = new Set(['node_modules', '.git', '$recycle.bin', '.hist', '.panelkeeper-recovery', '.panelkeeper-trash']);

    async function visit(dir, depth) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            log(`Cannot read source directory "${dir}": ${error.message}`, 'ERROR');
            return;
        }
        const cbz = entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz');
        const relativeDepth = depth;
        const isSeriesDepth = folderMode === 'auto'
            ? relativeDepth >= 1
            : folderMode === 'direct' ? relativeDepth === 1 : relativeDepth >= 2;
        if (dir !== sourceRoot && cbz.length && isSeriesDepth) {
            results.push({ name: path.basename(dir), path: dir, count: cbz.length });
            return;
        }

        if (folderMode === 'direct' && relativeDepth >= 1) return;
        if (depth >= 6) return;
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const entry of entries) {
            if (!entry.isDirectory() || skipNames.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.panelkeeper-')) continue;
            const child = path.join(dir, entry.name);

            if (destRoot && (samePath(destRoot, child) || isWithin(destRoot, child))) continue;
            await visit(child, depth + 1);
        }
    }

    await visit(path.resolve(sourceRoot), 0);
    return results;
}

function attachDiscoveredPathToMapping(mapping, source) {
    if (!mapping || !source?.path || !mapping.id) return false;
    const resolvedPath = path.resolve(source.path);
    const pathOwner = db.prepare('SELECT mapping_id FROM series_mapping_sources WHERE source_path=?').get(resolvedPath);
    if (pathOwner) return Number(pathOwner.mapping_id) === Number(mapping.id);

    const legacyOwner = db.prepare('SELECT id FROM series_mappings WHERE source_path=? AND id<>? LIMIT 1')
        .get(resolvedPath, mapping.id);
    if (legacyOwner) return false;

    const now = new Date().toISOString();
    const inserted = db.prepare(`INSERT OR IGNORE INTO series_mapping_sources
        (mapping_id, source_folder, source_path, source_file_count, last_seen)
        VALUES (?, ?, ?, ?, ?)`)
        .run(mapping.id, source.name || mapping.source_folder, resolvedPath, Number(source.count || 0), now);

    if (inserted.changes) {

        const current = db.prepare('SELECT source_path FROM series_mappings WHERE id=?').get(mapping.id);
        if (!current?.source_path) {
            db.prepare('UPDATE series_mappings SET source_path=?, source_file_count=?, source_last_seen=? WHERE id=?')
                .run(resolvedPath, Number(source.count || 0), now, mapping.id);
        }
        log(`[MAPPING AUTO-ATTACHED] Exact source title "${source.name || mapping.source_folder}" found at another path; attached it to "${mapping.target_series}" (${resolvedPath}).`);
        return true;
    }
    const saved = db.prepare('SELECT mapping_id FROM series_mapping_sources WHERE source_path=?').get(resolvedPath);
    return Number(saved?.mapping_id) === Number(mapping.id);
}

function autoAttachExactTitlePaths(sourceSeries, mappingRows) {
    const byTitle = new Map();
    for (const mapping of mappingRows || []) {
        if (!mapping.active) continue;
        const key = String(mapping.source_folder || '').trim().toLowerCase();
        if (!key) continue;
        if (!byTitle.has(key)) byTitle.set(key, []);
        byTitle.get(key).push(mapping);
    }
    let attached = 0;
    for (const source of sourceSeries || []) {
        const matches = byTitle.get(String(source.name || '').trim().toLowerCase()) || [];

        if (matches.length !== 1) continue;
        const resolvedPath = path.resolve(source.path);
        const before = db.prepare('SELECT mapping_id FROM series_mapping_sources WHERE source_path=?').get(resolvedPath);
        if (!before && attachDiscoveredPathToMapping(matches[0], source)) {
            attached++;
        } else if (before && Number(before.mapping_id) === Number(matches[0].id)) {
            db.prepare(`UPDATE series_mapping_sources SET source_folder=?, source_file_count=?, last_seen=? WHERE source_path=? AND mapping_id=?`)
                .run(source.name || matches[0].source_folder, Number(source.count || 0), new Date().toISOString(), resolvedPath, matches[0].id);
        }
    }
    return attached;
}

function clearQcIssueFlag(filePath, issueName) {
    const resolved = path.resolve(filePath);
    const row = qcDb.prepare('SELECT size, mtime, issues, reason FROM qc_cache WHERE path=?').get(resolved);
    if (!row) return;
    let issues = [];
    try { issues = JSON.parse(row.issues || '[]'); } catch (_) {}
    const remaining = issues.filter(issue => issue !== issueName);
    if (!remaining.length) {
        qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(resolved);
        return;
    }
    const stats = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stats) {
        qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(resolved);
        return;
    }
    qcDb.prepare(`UPDATE qc_cache SET size=?, mtime=?, issues=?, has_issues=?, scanned_at=?, parser_version=? WHERE path=?`)
        .run(stats.size, Math.floor(stats.mtimeMs), JSON.stringify(remaining), remaining.length ? 1 : 0, new Date().toISOString(), QC_ANALYSIS_VERSION, resolved);
}

function findMappedTargetForSourceFile(filePath) {
    const resolved = path.resolve(filePath);
    const rows = db.prepare(`SELECT s.source_path, m.target_series, m.id
        FROM series_mapping_sources s JOIN series_mappings m ON m.id=s.mapping_id
        WHERE m.active=1`).all();
    const legacy = db.prepare('SELECT source_path, target_series, id FROM series_mappings WHERE active=1 AND source_path<>\'\'').all();
    const candidates = [...rows, ...legacy].filter(row => row.source_path && isWithin(row.source_path, resolved));
    candidates.sort((a, b) => path.resolve(b.source_path).length - path.resolve(a.source_path).length);
    return candidates[0] || null;
}

async function findChapterCollision(targetPath, targetSeriesName, chapter, sourceFile) {
    const destination = buildChapterDestination(targetPath, targetSeriesName, chapter);
    if (await fs.pathExists(destination.path) && !samePath(destination.path, sourceFile)) return destination.path;
    for (const candidatePath of await listSeriesChapterFiles(targetPath)) {
        if (samePath(candidatePath, sourceFile)) continue;
        const parsed = parseSeriesChapter(path.basename(candidatePath), targetSeriesName);
        if (parsed && parsed.key === chapter.key) return candidatePath;
    }
    return null;
}

function savePendingConflict(sourcePath, destinationPath, targetSeriesName, chapter, decisionReason = '', comparison = null) {
    const now = new Date().toISOString();
    let sourceSize = 0;
    let destinationSize = 0;
    try { sourceSize = fs.statSync(sourcePath).size; } catch (_) {}
    try { destinationSize = fs.statSync(destinationPath).size; } catch (_) {}
    const resolvedSource = path.resolve(sourcePath);
    const resolvedDestination = path.resolve(destinationPath);
    const existing = db.prepare("SELECT id FROM pending_conflicts WHERE source_path=? AND destination_path=? AND status='pending'")
        .get(resolvedSource, resolvedDestination);
    const details = [String(decisionReason || '').slice(0, 2000), comparison?.sourcePageCount || 0, comparison?.libraryPageCount || 0];
    if (existing) {
        db.prepare('UPDATE pending_conflicts SET source_size=?, destination_size=?, decision_reason=?, source_page_count=?, destination_page_count=?, updated_at=? WHERE id=?')
            .run(sourceSize, destinationSize, ...details, now, existing.id);
        return existing.id;
    }
    const result = db.prepare(`INSERT INTO pending_conflicts
        (source_path, destination_path, target_series, chapter_key, chapter_label, source_size, destination_size, decision_reason, source_page_count, destination_page_count, created_at, updated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(resolvedSource, resolvedDestination, targetSeriesName, chapter.key, chapter.label, sourceSize, destinationSize, ...details, now, now);
    sendNotification(`PanelKeeper has a chapter conflict: ${targetSeriesName} ${chapter.label}. Review the two versions in Chapter Conflicts.`, { event: 'conflicts' }).catch(() => {});
    return Number(result.lastInsertRowid);
}

async function buildChapterIndex(targetPath, targetSeriesName) {
    const lookup = new Map();
    for (const filePath of await listSeriesChapterFiles(targetPath)) {
        const name = path.basename(filePath);
        const chapter = parseSeriesChapter(name, targetSeriesName);
        if (chapter) {
            if (chapter.special) assignSpecialNumber(targetSeriesName, targetPath, chapter);
            if (!lookup.has(chapter.key)) lookup.set(chapter.key, filePath);
        }
    }
    return lookup;
}

async function autoResolveChapterCollision(sourceFile, existingFile, canonicalPath, targetSeriesName, chapter, sourceDirectory) {
    const existingDirectory = await zip.readZipDirectory(existingFile);
    const comparison = await zip.compareImageCoverage(sourceFile, sourceDirectory, existingFile, existingDirectory);
    const { destRoot, sourceRoot } = getRoots();

    if (comparison.relation === 'source_superset') {
        if (!isWithin(destRoot, existingFile) || (!isWithin(sourceRoot, sourceFile) && !isWithin(destRoot, sourceFile))) {
            return { resolved: false, reason: 'A path safety check prevented an automatic upgrade.' };
        }
        if (await fs.pathExists(canonicalPath) && !samePath(canonicalPath, existingFile)) {
            return { resolved: false, reason: 'A second CBZ already occupies the canonical chapter filename. Automatic replacement was stopped to protect both library copies.' };
        }
        const recovered = await createRecoveryForPath(existingFile, targetSeriesName);
        try {
            await fs.move(sourceFile, canonicalPath, { overwrite: false });
        } catch (error) {
            if (!(await fs.pathExists(existingFile)) && await fs.pathExists(recovered.backupPath)) {
                await fs.move(recovered.backupPath, existingFile, { overwrite: false }).catch(() => {});
                db.prepare("UPDATE recovery_items SET status='restored_after_error' WHERE id=?").run(recovered.id);
            }
            throw error;
        }
        qcDb.prepare('DELETE FROM qc_cache WHERE path IN (?, ?)').run(path.resolve(sourceFile), path.resolve(canonicalPath));
        db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(path.resolve(sourceFile));
        resolveFileIssue(sourceFile);
        log(`[AUTO UPGRADE] ${targetSeriesName} ${chapter.label}: the download contains every existing library image in order plus additional images. Previous version moved to Recovery (${comparison.verifiedPages} matching images verified).`);
        return { resolved: true, relation: comparison.relation };
    }

    if (comparison.relation === 'library_superset' || comparison.relation === 'identical') {
        if (isWithin(destRoot, sourceFile)) {
            await createRecoveryForPath(sourceFile, targetSeriesName);
        } else if (isWithin(sourceRoot, sourceFile)) {
            await fs.remove(sourceFile);
        } else {
            return { resolved: false, reason: 'The duplicate source is outside the configured source and destination roots.' };
        }
        qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(path.resolve(sourceFile));
        db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(path.resolve(sourceFile));
        resolveFileIssue(sourceFile);
        log(comparison.relation === 'identical'
            ? `[AUTO DUPLICATE] ${targetSeriesName} ${chapter.label}: the downloaded and library chapters contain identical images in identical order. Removed the incoming duplicate.`
            : `[AUTO KEEP] ${targetSeriesName} ${chapter.label}: every downloaded image is already present in the library version in the same order. Removed the incomplete duplicate download.`);
        return { resolved: true, relation: comparison.relation };
    }

    return { resolved: false, reason: comparison.reason || 'The two versions could not be ranked safely.', comparison };
}

async function applyComicInfoUpdateToArchive(filePath, series, parsed = null, { createRecovery = true } = {}) {
    const current = await zip.readComicInfoText(filePath);

    if (!current.exists) return { changed: false, policy: 'update', missingComicInfo: true };
    const context = getComicInfoChapterContext(filePath, series, parsed);
    const xml = comicInfoUtils.updateComicInfoIdentity(current.xml, context);
    if (current.xml.trim() === xml.trim()) return { changed: false, policy: 'update' };
    const snapshot = createRecovery ? await createRecoverySnapshotForPath(filePath, series) : null;
    const result = await zip.writeComicInfoInPlace(filePath, xml);
    db.prepare('DELETE FROM processed_files WHERE path=?').run(path.resolve(filePath));
    return { changed: true, policy: 'update', result, recoveryId: snapshot?.id || null };
}

async function applyComicInfoPolicyToIncoming(filePath, series, parsed = null) {
    const policy = getComicInfoPolicy(series);
    if (policy === 'leave') return { changed: false, policy };
    const current = await zip.readComicInfoText(filePath);
    const { destRoot } = getRoots();
    const isExistingLibraryArchive = Boolean(destRoot && isWithin(destRoot, path.resolve(filePath)));
    if (policy === 'remove') {
        if (!current.exists) return { changed: false, policy };
        if (isExistingLibraryArchive) await createRecoverySnapshotForPath(filePath, series);
        const result = await zip.removeComicInfoInPlace(filePath);
        return { changed: Boolean(result.removedCount), policy, result };
    }
    if (policy === 'update') {
        return applyComicInfoUpdateToArchive(filePath, series, parsed, { createRecovery: isExistingLibraryArchive });
    }
    const template = getComicInfoTemplate(series);
    if (!template) {
        log(`[COMICINFO] ${policy} is selected for ${series}, but no global or series template is saved. The incoming XML was left unchanged.`, 'WARN');
        return { changed: false, policy, missingTemplate: true };
    }
    const chapterTemplate = comicInfoUtils.renderComicInfoTemplate(template, getComicInfoChapterContext(filePath, series, parsed));
    const xml = policy === 'replace'
        ? comicInfoUtils.validateComicInfoXml(chapterTemplate)
        : current.exists ? comicInfoUtils.upgradeComicInfoXml(current.xml, chapterTemplate) : comicInfoUtils.validateComicInfoXml(chapterTemplate);
    if (current.exists && current.xml.trim() === xml.trim()) return { changed: false, policy };
    if (isExistingLibraryArchive) await createRecoverySnapshotForPath(filePath, series);
    const result = await zip.writeComicInfoInPlace(filePath, xml);
    return { changed: true, policy, result };
}

async function processFiles(currentPath, targetSeriesName, destRoot, options = {}) {
    const validation = validateSeriesName(targetSeriesName);
    if (!validation.valid) {
        log(`Invalid target series name "${targetSeriesName}": ${validation.message}`, 'ERROR');
        return;
    }
    targetSeriesName = validation.value;
    const resolvedTarget = path.resolve(destRoot, targetSeriesName);
    if (!isWithin(destRoot, resolvedTarget) || samePath(resolvedTarget, destRoot)) {
        log(`Refused unsafe destination folder for series "${targetSeriesName}".`, 'ERROR');
        return;
    }

    let entries;
    try { entries = await fs.readdir(currentPath, { withFileTypes: true }); }
    catch (error) {
        log(`Cannot read folder "${currentPath}": ${error.message}`, 'ERROR');
        return;
    }
    const files = entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz')
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const minAgeSeconds = Math.max(0, Math.min(3600, Number(getSetting('minimumFileAgeSeconds', '120')) || 0));
    const comicInfoPolicy = getComicInfoPolicy(targetSeriesName);

    await fs.ensureDir(resolvedTarget);
    let chapterLookup;
    try { chapterLookup = await buildChapterIndex(resolvedTarget, targetSeriesName); }
    catch (error) {
        log(`Cannot index existing chapters in "${resolvedTarget}": ${error.message}`, 'ERROR');
        return;
    }

    let processedInBatch = 0;
    for (const file of files) {
        const sourceFile = path.join(currentPath, file);
        let sourceStats;
        try { sourceStats = await fs.stat(sourceFile); }
        catch (error) { log(`Cannot stat "${sourceFile}": ${error.message}`, 'WARN'); continue; }

        if (minAgeSeconds && (Date.now() - sourceStats.mtimeMs) < minAgeSeconds * 1000) {
            log(`[WAIT] Skipping recently changed file for ${minAgeSeconds}s stability window: ${file}`);
            continue;
        }

        let sourceDirectory;
        try {
            sourceDirectory = await zip.readZipDirectory(sourceFile);
        } catch (error) {
            recordFileIssue(sourceFile, archiveIssueKind(error), error.message, sourceStats);
            log(`[ARCHIVE ERROR] ${file}: ${error.message}. Left in the source folder.`, 'ERROR');
            continue;
        }

        const override = db.prepare('SELECT chapter_label, chapter_key FROM chapter_overrides WHERE path=?').get(path.resolve(sourceFile));
        const parsedChapter = parseSeriesChapter(file, targetSeriesName);
        const parsedOverride = override ? parseSeriesChapterLabel(override.chapter_label, targetSeriesName) : null;
        const chapter = override
            ? resolveChapterOverride(parsedChapter, parsedOverride || (override.chapter_label ? {
                label: override.chapter_label, key: override.chapter_key,
                special: String(override.chapter_key || '').startsWith('special:')
            } : null), override, targetSeriesName)
            : parsedChapter;
        if (!chapter) {
            recordFileIssue(sourceFile, 'unparsed_chapter', 'Could not reliably find a chapter number/special name in this filename. Rename or map it, then retry.', sourceStats);
            log(`[NEEDS REVIEW] Could not parse chapter in "${file}". Left in source.`, 'WARN');
            continue;
        }

        if (comicInfoPolicy !== 'leave') {
            try {
                const result = await applyComicInfoPolicyToIncoming(sourceFile, targetSeriesName, chapter);
                if (result.changed) {
                    log(`[COMICINFO ${result.policy.toUpperCase()}] ${file}: updated incoming ComicInfo.xml.`);
                    sourceStats = await fs.stat(sourceFile);
                    sourceDirectory = await zip.readZipDirectory(sourceFile);
                }
            } catch (error) {
                recordFileIssue(sourceFile, 'xml_cleanup_failed', `ComicInfo ${comicInfoPolicy} policy failed: ${error.message}`, sourceStats);
                log(`[COMICINFO ${comicInfoPolicy.toUpperCase()} FAILED] ${file}: ${error.message}. Left in the download folder for review.`, 'ERROR');
                continue;
            }
        }

        let destination;
        try { destination = buildChapterDestination(resolvedTarget, targetSeriesName, chapter); }
        catch (error) {
            recordFileIssue(sourceFile, 'unparsed_chapter', `Could not assign a safe chapter/Special destination: ${error.message}`, sourceStats);
            log(`[NEEDS REVIEW] ${file}: ${error.message}. Left in source.`, 'WARN');
            continue;
        }
        const canonicalName = destination.fileName;
        const canonicalPath = destination.path;
        await fs.ensureDir(destination.directory);
        const collision = chapterLookup.get(chapter.key) || null;

        if (collision && !samePath(collision, sourceFile)) {
            try {
                const completionState = db.prepare('SELECT completed FROM library_series_state WHERE lower(series)=lower(?)').get(targetSeriesName);

                const autoResult = completionState?.completed
                    ? { resolved: false, reason: 'This manga is marked complete. Every replacement or duplicate chapter requires manual review.' }
                    : await autoResolveChapterCollision(sourceFile, collision, canonicalPath, targetSeriesName, chapter, sourceDirectory);
                if (autoResult.resolved) {
                    const upgradedPath = autoResult.relation === 'source_superset' ? canonicalPath : collision;
                    await applyCoverRuleToFile(upgradedPath, targetSeriesName).catch(error => log(`[COVER APPLY WARN] ${path.basename(upgradedPath)}: ${error.message}`, 'WARN'));
                    chapterLookup.set(chapter.key, upgradedPath);
                    continue;
                }
                const conflictId = savePendingConflict(sourceFile, collision, targetSeriesName, chapter, autoResult.reason, autoResult.comparison);
                resolveFileIssue(sourceFile);
                const reason = autoResult.reason || autoResult.comparison?.reason || 'The chapter versions contain different page images or layouts.';
                log(`[REVIEW #${conflictId}] ${targetSeriesName} ${chapter.label}: automatic comparison was inconclusive. ${reason} Download remains queued; library copy is untouched.`, 'WARN');
                continue;
            } catch (error) {
                const conflictId = savePendingConflict(sourceFile, collision, targetSeriesName, chapter, `Automatic comparison failed: ${error.message}`);
                resolveFileIssue(sourceFile);
                log(`[REVIEW #${conflictId}] ${targetSeriesName} ${chapter.label}: automatic comparison failed safely. ${error.message}`, 'WARN');
                continue;
            }
        }

        if (samePath(sourceFile, canonicalPath)) {
            resolveFileIssue(sourceFile);
            await applyCoverRuleToFile(canonicalPath, targetSeriesName).catch(error => log(`[COVER APPLY WARN] ${path.basename(canonicalPath)}: ${error.message}`, 'WARN'));
            chapterLookup.set(chapter.key, canonicalPath);
            continue;
        }

        try {
            await fs.move(sourceFile, canonicalPath, { overwrite: false });
            resolveFileIssue(sourceFile);
            db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(path.resolve(sourceFile));
            qcDb.prepare('DELETE FROM qc_cache WHERE path IN (?, ?)').run(path.resolve(sourceFile), path.resolve(canonicalPath));
            chapterLookup.set(chapter.key, canonicalPath);
            await applyCoverRuleToFile(canonicalPath, targetSeriesName).catch(error => log(`[COVER APPLY WARN] ${path.basename(canonicalPath)}: ${error.message}`, 'WARN'));
            log(`[MOVED] "${file}" -> "${canonicalName}"`);
        } catch (error) {
            recordFileIssue(sourceFile, 'move_failed', `Could not move file to "${canonicalPath}": ${error.message}`, sourceStats);
            log(`[MOVE ERROR] ${file}: ${error.message}. The download was left in place.`, 'ERROR');
        }

        processedInBatch++;
        if (processedInBatch % 20 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    touchedLibrarySeries.add(targetSeriesName);
    try {
        if ((await fs.readdir(currentPath)).length === 0 && !samePath(currentPath, resolvedTarget)) {
            await fs.remove(currentPath);
        }
    } catch (_) {}
}

async function moveAndRename() {
    log('Starting download processing...');
    const { sourceRoot, destRoot } = getRoots();
    if (!sourceRoot || !destRoot) {
        log('Source Root and Destination must both be configured in Settings.', 'ERROR');
        return { processed: false, reason: 'paths_not_configured' };
    }
    if (!(await fs.pathExists(sourceRoot))) {
        log(`Source root is not accessible: "${sourceRoot}". Check the path, mapped-drive session, and account running Node.js.`, 'ERROR');
        return { processed: false, reason: 'source_unavailable' };
    }
    if (!(await fs.pathExists(destRoot))) {
        log(`Destination is not accessible: "${destRoot}". Check the path, mapped-drive session, and write permissions.`, 'ERROR');
        return { processed: false, reason: 'destination_unavailable' };
    }
    const sourceStat = await fs.stat(sourceRoot).catch(() => null);
    const destStat = await fs.stat(destRoot).catch(() => null);
    if (!sourceStat?.isDirectory() || !destStat?.isDirectory()) {
        log('Source Root and Destination must point to existing directories. Use Settings → Test Paths.', 'ERROR');
        return { processed: false, reason: 'not_directories' };
    }
    try {

        await fs.access(sourceRoot, fs.constants.R_OK | fs.constants.W_OK);
        await fs.readdir(sourceRoot);
        await fs.access(destRoot, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
        log(`Configured path is not usable by the running server: ${error.message}. Use Settings → Test Paths; a Windows mapped drive may not exist in this account/session.`, 'ERROR');
        return { processed: false, reason: 'path_access_denied' };
    }
    if (samePath(sourceRoot, destRoot)) {
        log('Source Root and Destination cannot be the same directory.', 'ERROR');
        return { processed: false, reason: 'same_paths' };
    }
    if (isWithin(destRoot, sourceRoot)) {
        log('Source Root is inside the Destination library. Refusing to scan overlapping roots because it could reprocess library files as downloads.', 'ERROR');
        return { processed: false, reason: 'overlapping_paths' };
    }

    let sourceSeries;
    try { sourceSeries = await discoverSourceSeries(path.resolve(sourceRoot), path.resolve(destRoot)); }
    catch (error) {
        log(`Source scan failed: ${error.message}`, 'ERROR');
        return { processed: false, reason: error.message };
    }
    let mappings = db.prepare('SELECT * FROM series_mappings WHERE active=1').all();

    autoAttachExactTitlePaths(sourceSeries, mappings);
    mappings = db.prepare('SELECT * FROM series_mappings WHERE active=1').all();
    const mappingLookup = new Map();
    for (const mapping of mappings) {
        const key = String(mapping.source_folder).trim().toLowerCase();
        if (!mappingLookup.has(key)) mappingLookup.set(key, []);
        mappingLookup.get(key).push(mapping);
    }
    const mappingSources = db.prepare(`SELECT s.*, m.target_series, m.active, m.source_folder AS primary_source_folder
        FROM series_mapping_sources s JOIN series_mappings m ON m.id=s.mapping_id WHERE m.active=1`).all();
    const pathLookup = new Map(mappingSources.map(source => [pathKey(source.source_path), {
        id: source.mapping_id, source_folder: source.source_folder, target_series: source.target_series,
        active: source.active, source_path: source.source_path
    }]));
    for (const mapping of mappings) {
        if (mapping.source_path && !pathLookup.has(pathKey(mapping.source_path))) {
            pathLookup.set(pathKey(mapping.source_path), mapping);
        }
    }
    let foldersMatched = 0;
    for (const item of sourceSeries) {
        const resolvedSourcePath = path.resolve(item.path);
        let mapping = pathLookup.get(pathKey(resolvedSourcePath)) || null;
        if (!mapping) {
            const namedMappings = mappingLookup.get(item.name.trim().toLowerCase()) || [];
            if (namedMappings.length === 1 && attachDiscoveredPathToMapping(namedMappings[0], item)) {
                mapping = namedMappings[0];
                pathLookup.set(pathKey(resolvedSourcePath), mapping);
            } else if (namedMappings.length > 1) {
                log(`[MAPPING TITLE AMBIGUOUS] ${item.name}: more than one active mapping uses this exact source title. No folder was processed automatically.`, 'WARN');
            }
        }
        if (!mapping) {
            log(`[UNMATCHED] ${item.name} (${resolvedSourcePath}): ${item.count} CBZ file(s) remain in the download folder until mapped.`, 'WARN');
            continue;
        }
        foldersMatched++;
        await processFiles(resolvedSourcePath, mapping.target_series, destRoot);
    }
    log(`Download scan complete: ${sourceSeries.length} series folder(s) found; ${foldersMatched} mapped.`);
    return { processed: true, folders: sourceSeries.length, matched: foldersMatched };
}

function updateMovedFileReferences(oldPath, newPath) {
    const oldResolved = path.resolve(oldPath);
    const newResolved = path.resolve(newPath);
    const pathTables = [
        ['processed_files', 'path'], ['chapter_overrides', 'path'], ['file_issues', 'path'],
        ['pending_conflicts', 'source_path'], ['pending_conflicts', 'destination_path'],
        ['cover_insertions', 'archive_path'], ['cover_insertions', 'cover_path'],
        ['series_cover_rules', 'cover_path'], ['cover_update_jobs', 'cover_path'],
        ['cover_update_items', 'archive_path'], ['series_chapter_cover_designs', 'source_path'],
        ['chapter_cover_insertions', 'archive_path'], ['chapter_cover_insertions', 'source_path'],
        ['chapter_cover_job_items', 'archive_path'], ['recovery_items', 'original_path'], ['recovery_items', 'backup_path'],
        ['library_chapter_inventory', 'path']
    ];
    const migrate = db.transaction(() => {
        for (const [table, column] of pathTables) {
            db.prepare(`UPDATE OR REPLACE "${table}" SET "${column}"=? WHERE "${column}"=?`).run(newResolved, oldResolved);
        }
    });
    migrate();
    try { qcDb.prepare('UPDATE OR REPLACE qc_cache SET path=? WHERE path=?').run(newResolved, oldResolved); }
    catch (error) { log(`[SPECIAL MOVE] Could not update QC cache path for ${path.basename(oldResolved)}: ${error.message}`, 'WARN'); }
}

async function normalizeRootSpecialFiles() {
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) return { moved: 0, conflicts: 0 };
    const seriesEntries = await fs.readdir(destRoot, { withFileTypes: true });
    let moved = 0;
    let conflicts = 0;
    for (const entry of seriesEntries) {
        if (!entry.isDirectory() || !isLibrarySeriesFolderName(entry.name)) continue;
        const series = entry.name;
        const seriesPath = path.join(destRoot, series);
        let chapterFiles;
        try { chapterFiles = await listSeriesChapterFiles(seriesPath); }
        catch (error) {
            log(`[SPECIAL NORMALIZE] Cannot inspect ${series}: ${error.message}`, 'WARN');
            continue;
        }
        for (const sourcePath of chapterFiles) {
            const name = path.basename(sourcePath);
            const chapter = parseSeriesChapter(name, series);
            if (!chapter?.special) continue;
            let destination;
            try { destination = buildChapterDestination(seriesPath, series, chapter); }
            catch (error) {
                log(`[SPECIAL NORMALIZE] Could not determine Kavita destination for ${name}: ${error.message}`, 'WARN');
                continue;
            }
            if (samePath(sourcePath, destination.path)) continue;
            if (await fs.pathExists(destination.path)) {
                conflicts++;
                savePendingConflict(sourcePath, destination.path, series, chapter,
                    'Both a root-level Special and its Kavita Specials/ destination exist. Review the two files before choosing which copy to keep.');
                log(`[SPECIAL NORMALIZE] ${name} remains in place because ${path.basename(destination.path)} already exists in Specials/. A conflict was queued.`, 'WARN');
                continue;
            }
            try {
                await fs.ensureDir(destination.directory);
                await fs.move(sourcePath, destination.path, { overwrite: false });
                updateMovedFileReferences(sourcePath, destination.path);
                touchedLibrarySeries.add(series);
                moved++;
                log(`[SPECIAL NORMALIZE] Moved ${name} into Kavita Specials/ as ${destination.fileName}.`);
            } catch (error) {
                log(`[SPECIAL NORMALIZE] Could not move ${name} into Specials/: ${error.message}`, 'WARN');
            }
        }
    }
    if (moved || conflicts) log(`Kavita Special folder check: ${moved} moved into Specials/; ${conflicts} conflict(s) need review.`);
    return { moved, conflicts };
}

async function auditAndFixLibrary() {
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) return;
    log('Running safe library folder audit...');
    let entries;
    try { entries = await fs.readdir(destRoot, { withFileTypes: true }); }
    catch (error) { log(`Cannot read library root: ${error.message}`, 'ERROR'); return; }

    const mappings = db.prepare('SELECT * FROM series_mappings WHERE active=1').all();
    const lookup = new Map(mappings.map(mapping => [String(mapping.source_folder).trim().toLowerCase(), mapping]));
    for (const entry of entries) {
        if (!entry.isDirectory() || !isLibrarySeriesFolderName(entry.name)) continue;
        const mapping = lookup.get(entry.name.trim().toLowerCase());
        if (!mapping || mapping.target_series.trim().toLowerCase() === entry.name.trim().toLowerCase()) continue;
        const wrongPath = path.join(destRoot, entry.name);
        log(`[AUDIT] Found source-named library folder "${entry.name}"; safely reprocessing toward "${mapping.target_series}".`, 'WARN');
        await processFiles(wrongPath, mapping.target_series, destRoot, { fromLibrary: true });
        try {
            if ((await fs.readdir(wrongPath)).length === 0) await fs.remove(wrongPath);
        } catch (_) {}
    }
}

function updateProcessedFile(filePath, stats) {
    db.prepare(`INSERT INTO processed_files (path, size, mtime, processed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, processed_at=excluded.processed_at`)
        .run(path.resolve(filePath), stats.size, Math.floor(stats.mtimeMs), new Date().toISOString());
}

async function applyComicInfoPolicyToLibrary({ force = false } = {}) {
    const { destRoot } = getRoots();
    const policy = force ? 'remove' : getComicInfoPolicy('');
    if (force) log('A legacy force-remove request was received; applying the Remove ComicInfo policy for compatibility.', 'WARN');
    if (policy === 'leave') {
        log('ComicInfo policy is Leave alone; the library metadata pass is disabled.');
        return { skipped: true, policy, cleaned: 0, changed: 0 };
    }
    const template = (policy === 'replace' || policy === 'upgrade') ? getComicInfoTemplate('') : '';
    if ((policy === 'replace' || policy === 'upgrade') && !template && !Object.values(readComicInfoTemplateStore()).some(Boolean)) {
        log(`ComicInfo policy is ${policy}, but no global or series template is saved. The existing library XML was left unchanged.`, 'WARN');
        return { skipped: true, policy, reason: 'missing_template', cleaned: 0, changed: 0 };
    }
    if (!destRoot || !(await fs.pathExists(destRoot))) {
        log(`Cannot apply ComicInfo policy because the library path is unavailable: "${destRoot}"`, 'ERROR');
        return { skipped: true, policy, cleaned: 0, changed: 0 };
    }

    log(`Scanning library CBZ archives for the ComicInfo policy action: ${policy} (compressed page data is not recompressed)...`);
    let scanned = 0;
    let changed = 0;
    let skipped = 0;
    let errors = 0;
    const previousPolicy = String(getSetting('comicInfoAppliedPolicy', '') || '');
    const policyChanged = previousPolicy !== policy;
    for await (const filePath of walkCbzFiles(destRoot, {
        onError: (dir, error) => log(`Cannot scan "${dir}": ${error.message}`, 'WARN')
    })) {
        scanned++;
        let stats;
        try { stats = await fs.stat(filePath); }
        catch (error) { log(`Cannot stat "${filePath}": ${error.message}`, 'WARN'); continue; }
        const record = db.prepare('SELECT size, mtime FROM processed_files WHERE path=?').get(path.resolve(filePath));
        if (!policyChanged && record && record.size === stats.size && record.mtime === Math.floor(stats.mtimeMs)) { skipped++; continue; }
        try {
            const current = await zip.readComicInfoText(filePath);
            let didChange = false;
            const series = seriesNameFromPath(filePath, destRoot);
            if (policy === 'remove') {
                if (current.exists) {
                    await createRecoverySnapshotForPath(filePath, series);
                    const result = await zip.removeComicInfoInPlace(filePath);
                    didChange = result.removedCount > 0;
                }
            } else if (policy === 'update') {
                if (current.exists) {
                    const nextXml = comicInfoUtils.updateComicInfoIdentity(current.xml, getComicInfoChapterContext(filePath, series));
                    if (current.xml.trim() !== nextXml.trim()) {
                        await createRecoverySnapshotForPath(filePath, series);
                        await zip.writeComicInfoInPlace(filePath, nextXml);
                        didChange = true;
                    }
                }
            } else {
                const seriesTemplate = getComicInfoTemplate(series) || template;
                if (!seriesTemplate) { skipped++; continue; }
                const chapterTemplate = comicInfoUtils.renderComicInfoTemplate(seriesTemplate, getComicInfoChapterContext(filePath, series));
                const nextXml = policy === 'replace'
                    ? comicInfoUtils.validateComicInfoXml(chapterTemplate)
                    : current.exists ? comicInfoUtils.upgradeComicInfoXml(current.xml, chapterTemplate) : comicInfoUtils.validateComicInfoXml(chapterTemplate);
                if (!current.exists || current.xml.trim() !== nextXml.trim()) {

                    await createRecoverySnapshotForPath(filePath, series);
                    await zip.writeComicInfoInPlace(filePath, nextXml);
                    didChange = true;
                }
            }
            if (didChange) {
                changed++;
                log(`[COMICINFO ${policy.toUpperCase()}] Updated ${path.basename(filePath)}.`);
            }
            const newStats = await fs.stat(filePath);
            updateProcessedFile(filePath, newStats);
            if (policy === 'remove' || didChange) resolveFileIssue(filePath);
        } catch (error) {
            errors++;
            recordFileIssue(filePath, 'xml_cleanup_failed', `ComicInfo ${policy} policy failed: ${error.message}`, stats);
            log(`[COMICINFO ${policy.toUpperCase()} FAILED] ${path.basename(filePath)}: ${error.message}. The file is listed in Files Needing Attention.`, 'ERROR');
        }
        if (scanned % 30 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('comicInfoAppliedPolicy', policy);
    log(`ComicInfo ${policy} pass complete: ${scanned} CBZ file(s) inspected; ${changed} changed; ${skipped} unchanged/skipped; ${errors} errors.`);
    if (changed || errors) sendNotification(`ComicInfo ${policy} policy pass completed: ${changed} file(s) changed, ${skipped} unchanged/skipped, ${errors} failed.`, { event: 'qc' }).catch(() => {});
    return { scanned, policy, changed, cleaned: policy === 'remove' ? changed : 0, skipped, errors };
}

function seriesNameFromPath(filePath, destRoot) {
    const relative = path.relative(path.resolve(destRoot), path.resolve(filePath));
    const first = relative.split(path.sep)[0];
    return first || path.basename(path.dirname(filePath));
}

function calculateMissingChapterNumbers(inventoryRows) {
    const present = new Set();
    for (const row of inventoryRows) {
        const number = Number(row.chapter_number);
        if (!row.is_special && !String(row.letter_suffix || '') && Number.isFinite(number) && Number.isInteger(number)) {
            present.add(number);
        }
    }
    if (present.size < 2) return { missing: [], count: 0, ranges: [] };
    const sorted = [...present].sort((a, b) => a - b);
    const missing = [];
    const ranges = [];
    let count = 0;
    for (let index = 1; index < sorted.length; index++) {
        const previous = sorted[index - 1];
        const current = sorted[index];
        if (current - previous <= 1) continue;
        const start = previous + 1;
        const end = current - 1;
        const length = end - start + 1;
        count += length;
        if (length === 1) ranges.push(String(start));
        else ranges.push(`${start}-${end}`);
        for (let number = start; number <= end && missing.length < 1000; number++) missing.push(number);
    }
    return { missing, count, ranges };
}

function calculateVolumeAwareMissingChapterNumbers(rows, volumeMode) {
    if (volumeMode === 'volume-only') {
        const present = new Set();
        for (const row of rows) {
            const start = Number(row.volume_number ?? row.chapter_number);
            const end = Number(row.volume_end_number ?? row.volume_number ?? row.chapter_number);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            for (let value = Math.ceil(start); value <= Math.floor(end) && value - start < 1001; value++) present.add(value);
        }
        const numeric = calculateMissingChapterNumbers([...present].map(number => ({ chapter_number: number, is_special: 0, letter_suffix: '' })));
        return {
            ...numeric,
            ranges: numeric.ranges.map(range => `Volume ${range}`),
            missing: numeric.missing,
            count: numeric.count
        };
    }
    if (volumeMode !== 'volume-chapters') return calculateMissingChapterNumbers(rows);
    const groups = new Map();
    for (const row of rows) {
        if (row.is_special || row.chapter_number === null || row.chapter_number === undefined || String(row.letter_suffix || '')) continue;
        const key = String(row.volume_key || '');
        const current = groups.get(key) || { volumeLabel: row.volume_label || '', rows: [] };
        current.rows.push(row);
        if (!current.volumeLabel && row.volume_label) current.volumeLabel = row.volume_label;
        groups.set(key, current);
    }
    const missing = [];
    const ranges = [];
    let count = 0;
    for (const [volumeKey, group] of groups) {
        const result = calculateMissingChapterNumbers(group.rows);
        count += result.count;
        missing.push(...result.missing.map(number => ({ volumeKey, volumeLabel: group.volumeLabel, chapter: number })));
        if (result.ranges.length) {
            const prefix = group.volumeLabel || (volumeKey ? `Volume ${volumeKey}` : 'Unassigned volume');
            ranges.push(`${prefix}: ${result.ranges.join(', ')}`);
        }
    }
    return { missing, count, ranges };
}

function catalogJobStatus(id) {
    const job = id
        ? db.prepare('SELECT * FROM library_catalog_jobs WHERE id=?').get(String(id))
        : db.prepare('SELECT * FROM library_catalog_jobs ORDER BY started_at DESC LIMIT 1').get();
    if (!job) return null;
    const current = job.status === 'running'
        ? db.prepare("SELECT series FROM library_catalog_queue WHERE job_id=? AND status='scanning' ORDER BY id LIMIT 1").get(job.id)?.series || null
        : null;
    const pending = Number(db.prepare("SELECT COUNT(*) AS count FROM library_catalog_queue WHERE job_id=? AND status='pending'").get(job.id)?.count || 0);
    return {
        id: job.id, status: job.status, reason: job.reason,
        totalSeries: job.total_series, doneSeries: job.done_series,
        errorCount: job.error_count, pendingSeries: pending, currentSeries: current,
        startedAt: job.started_at, updatedAt: job.updated_at,
        finishedAt: job.finished_at, error: job.error
    };
}

function seedCompletedChapterSnapshot(series, records, scannedAt) {
    const normalized = completedSeriesUtils.normalizeCurrentChapterRecords(records, scannedAt);
    const insert = db.prepare(`INSERT OR IGNORE INTO library_completed_chapters
        (series, identity_key, chapter_label, file_name, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    for (const record of normalized) {
        insert.run(series, record.identity_key, record.chapter_label, record.file_name, scannedAt, scannedAt);
    }
}

function reconcileCompletedChapterTracking(series, records, scannedAt) {
    const seriesState = db.prepare('SELECT completed FROM library_series_state WHERE lower(series)=lower(?)').get(series);
    if (!seriesState?.completed) return [];

    let tracking = db.prepare('SELECT * FROM library_completion_tracking WHERE lower(series)=lower(?)').get(series);
    if (!tracking) {
        db.prepare(`INSERT INTO library_completion_tracking (series, baseline_ready, created_at, updated_at)
            VALUES (?, 0, ?, ?)` ).run(series, scannedAt, scannedAt);
        tracking = { series, baseline_ready: 0 };
    }

    if (!tracking.baseline_ready) {
        seedCompletedChapterSnapshot(series, records, scannedAt);
        db.prepare('UPDATE library_completion_tracking SET baseline_ready=1, updated_at=? WHERE lower(series)=lower(?)')
            .run(scannedAt, series);
        log(`[COMPLETED SERIES TRACKING] Initial chapter baseline saved for ${series}: ${completedSeriesUtils.normalizeCurrentChapterRecords(records, scannedAt).length} distinct chapter/file identities.`);
        return [];
    }

    const baseline = db.prepare(`SELECT identity_key, chapter_label, file_name, first_seen_at, last_seen_at,
            missing_since, notified_at, last_attempt_at
        FROM library_completed_chapters WHERE lower(series)=lower(?)`).all(series);
    const reconciliation = completedSeriesUtils.reconcileCompletedChapterSnapshot({ baseline, currentRecords: records, scannedAt });
    const apply = db.transaction(() => {
        const insert = db.prepare(`INSERT OR IGNORE INTO library_completed_chapters
            (series, identity_key, chapter_label, file_name, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)`);
        for (const row of reconciliation.additions) {
            insert.run(series, row.identity_key, row.chapter_label, row.file_name, scannedAt, scannedAt);
        }
        const update = db.prepare(`UPDATE library_completed_chapters SET chapter_label=?, file_name=?, last_seen_at=?,
            missing_since=?, notified_at=?, last_attempt_at=? WHERE lower(series)=lower(?) AND identity_key=?`);
        for (const row of reconciliation.updates) {
            update.run(row.chapter_label, row.file_name, row.last_seen_at || scannedAt, row.missing_since,
                row.notified_at, row.last_attempt_at, series, row.identity_key);
        }
        db.prepare('UPDATE library_completion_tracking SET updated_at=? WHERE lower(series)=lower(?)').run(scannedAt, series);
    });
    apply();
    return reconciliation.notificationCandidates;
}

async function notifyCompletedSeriesMissingChapters(series, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return { sent: false, skipped: true };
    const attemptedAt = new Date().toISOString();
    const markAttempt = db.prepare(`UPDATE library_completed_chapters SET last_attempt_at=?
        WHERE lower(series)=lower(?) AND identity_key=? AND missing_since IS NOT NULL AND notified_at IS NULL`);
    const markNotified = db.prepare(`UPDATE library_completed_chapters SET notified_at=?
        WHERE lower(series)=lower(?) AND identity_key=? AND missing_since IS NOT NULL AND notified_at IS NULL`);
    db.transaction(() => {
        for (const item of candidates) markAttempt.run(attemptedAt, series, item.identity_key);
    })();

    const message = completedSeriesUtils.buildCompletedChapterMissingMessage(series, candidates);
    const result = await sendNotification(message, { event: 'completed_chapter_missing' });
    if (result.sent) {
        db.transaction(() => {
            for (const item of candidates) markNotified.run(attemptedAt, series, item.identity_key);
        })();
        log(`[COMPLETED SERIES MISSING] Notification sent for ${series}: ${candidates.length} previously tracked chapter/file identity(ies) missing.`);
    } else {
        const reason = result.reason || (result.skipped ? 'Notification disabled.' : 'Webhook delivery was not confirmed.');
        log(`[COMPLETED SERIES MISSING] ${series} has ${candidates.length} missing previously tracked chapter/file identity(ies); notification not sent: ${reason}`, 'WARN');
    }
    return result;
}

async function scanLibrarySeriesDirectory(series) {
    const { destRoot } = getRoots();
    if (!destRoot || getPathPresence(destRoot) !== true) throw new Error('The manga library path is unavailable.');
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    if (!isLibrarySeriesFolderName(validation.value)) throw new Error('This is a reserved metadata/system directory, not a manga series.');
    const seriesPath = path.resolve(destRoot, validation.value);
    if (!isWithin(destRoot, seriesPath) || samePath(seriesPath, destRoot)) throw new Error('Invalid manga folder path.');
    let seriesStat;
    try { seriesStat = await fs.stat(seriesPath); }
    catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
            throw new Error(`The manga folder is missing or unavailable: ${validation.value}. Its completed-chapter history was not changed.`);
        }
        throw error;
    }
    if (!seriesStat.isDirectory()) throw new Error(`The manga path is not an accessible directory: ${validation.value}.`);
    const chapterFiles = await listSeriesChapterFiles(seriesPath);
    const scannedAt = new Date().toISOString();
    const records = [];
    const keyCounts = new Map();
    const numericRows = [];
    for (const fullPath of chapterFiles) {
        const entryName = path.basename(fullPath);
        const chapter = parseQcChapterPath(fullPath, validation.value);
        const record = {
            path: fullPath,
            series: validation.value,
            file_name: entryName,
            chapter_key: chapter?.key || null,
            chapter_label: chapter?.label || null,
            chapter_number: chapter && chapter.number !== null && Number.isFinite(Number(chapter.number)) ? Number(chapter.number) : null,
            letter_suffix: chapter?.letterSuffix || '',
            is_special: chapter?.special ? 1 : 0,
            volume_key: chapter?.volumeKey || '',
            volume_label: chapter?.volumeLabel || '',
            volume_number: chapter?.volumeNumber ?? null,
            volume_end_number: chapter?.volumeEndNumber ?? chapter?.volumeNumber ?? null,
            is_volume: chapter?.isVolume || chapter?.volumeOnly ? 1 : 0,
            scanned_at: scannedAt
        };
        records.push(record);
        if (record.chapter_key) keyCounts.set(record.chapter_key, (keyCounts.get(record.chapter_key) || 0) + 1);
        if (record.chapter_number !== null) numericRows.push(record);
    }
    const volumeMode = getSeriesVolumeMode(validation.value);
    const uniqueChapterCount = libraryInventoryUtils.countDistinctRegularChapters(records, volumeMode);
    const duplicateCount = [...keyCounts.values()].filter(count => count > 1).length;
    const missing = calculateVolumeAwareMissingChapterNumbers(records, volumeMode);
    const insert = db.prepare(`INSERT INTO library_chapter_inventory
        (path, series, file_name, chapter_key, chapter_label, chapter_number, letter_suffix, is_special, volume_key, volume_label, volume_number, volume_end_number, is_volume, scanned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.transaction(() => {
        db.prepare('DELETE FROM library_chapter_inventory WHERE lower(series)=lower(?)').run(validation.value);
        for (const row of records) insert.run(row.path, row.series, row.file_name, row.chapter_key, row.chapter_label,
            row.chapter_number, row.letter_suffix, row.is_special, row.volume_key, row.volume_label, row.volume_number,
            row.volume_end_number, row.is_volume, row.scanned_at);
        db.prepare(`INSERT INTO library_series_state
            (series, completed, notes, file_count, chapter_count, missing_count, duplicate_count, unparsed_count, special_count, last_scanned_at, updated_at)
            VALUES (?, 0, '', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(series) DO UPDATE SET file_count=excluded.file_count, chapter_count=excluded.chapter_count,
                missing_count=excluded.missing_count, duplicate_count=excluded.duplicate_count,
                unparsed_count=excluded.unparsed_count, special_count=excluded.special_count,
                last_scanned_at=excluded.last_scanned_at, updated_at=excluded.updated_at`)
            .run(validation.value, records.length, uniqueChapterCount, missing.count, duplicateCount,
                records.filter(row => !row.chapter_key).length, records.filter(row => row.is_special).length, scannedAt, scannedAt);
    });
    update();
    const missingCompletedChapters = reconcileCompletedChapterTracking(validation.value, records, scannedAt);
    if (missingCompletedChapters.length) {
        await notifyCompletedSeriesMissingChapters(validation.value, missingCompletedChapters);
    }
    return {
        series: validation.value, fileCount: records.length, chapterCount: uniqueChapterCount,
        missingCount: missing.count, missingRanges: missing.ranges,
        duplicateCount, unparsedCount: records.filter(row => !row.chapter_key).length,
        lastScannedAt: scannedAt
    };
}

async function processLibraryCatalogJob(jobId) {
    if (libraryCatalogWorkerRunning) return;
    libraryCatalogWorkerRunning = true;
    activeLibraryCatalogJobId = String(jobId);
    try {
        while (true) {
            if (pipelinePromise) {
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
            const queueItem = db.prepare("SELECT * FROM library_catalog_queue WHERE job_id=? AND status='pending' ORDER BY id LIMIT 1").get(String(jobId));
            if (!queueItem) break;
            if (!isLibrarySeriesFolderName(queueItem.series)) {
                db.prepare("UPDATE library_catalog_queue SET status='skipped', error='Reserved metadata/system directory excluded from manga inventory.' WHERE id=?").run(queueItem.id);
                db.prepare('UPDATE library_catalog_jobs SET done_series=done_series+1, updated_at=? WHERE id=?')
                    .run(new Date().toISOString(), String(jobId));
                continue;
            }
            db.prepare("UPDATE library_catalog_queue SET status='scanning', error=NULL WHERE id=?").run(queueItem.id);
            activeLibraryCatalogSeries = queueItem.series;
            try {
                await scanLibrarySeriesDirectory(queueItem.series);
                db.prepare("UPDATE library_catalog_queue SET status='done', error=NULL WHERE id=?").run(queueItem.id);
                db.prepare('UPDATE library_catalog_jobs SET done_series=done_series+1, updated_at=? WHERE id=?')
                    .run(new Date().toISOString(), String(jobId));
            } catch (error) {
                db.prepare("UPDATE library_catalog_queue SET status='error', error=? WHERE id=?").run(String(error.message).slice(0, 1000), queueItem.id);
                db.prepare('UPDATE library_catalog_jobs SET done_series=done_series+1, error_count=error_count+1, updated_at=? WHERE id=?')
                    .run(new Date().toISOString(), String(jobId));
                log(`[LIBRARY INVENTORY] Could not scan "${queueItem.series}": ${error.message}`, 'WARN');
            } finally {
                activeLibraryCatalogSeries = '';
            }
            await new Promise(resolve => setImmediate(resolve));
        }
        const errors = Number(db.prepare("SELECT COUNT(*) AS count FROM library_catalog_queue WHERE job_id=? AND status='error'").get(String(jobId)).count || 0);
        const status = errors ? 'completed_with_errors' : 'completed';
        const now = new Date().toISOString();
        db.prepare('UPDATE library_catalog_jobs SET status=?, error_count=?, updated_at=?, finished_at=? WHERE id=?')
            .run(status, errors, now, now, String(jobId));
        log(`Library inventory scan ${status}: ${catalogJobStatus(jobId)?.doneSeries || 0} manga folders checked; ${errors} folder error(s).`);
    } catch (error) {
        const now = new Date().toISOString();
        db.prepare("UPDATE library_catalog_queue SET status='pending' WHERE job_id=? AND status='scanning'").run(String(jobId));
        db.prepare("UPDATE library_catalog_jobs SET status='failed', error=?, updated_at=?, finished_at=? WHERE id=?")
            .run(error.message, now, now, String(jobId));
        log(`Library inventory scan failed: ${error.stack || error.message}`, 'ERROR');
    } finally {
        libraryCatalogWorkerRunning = false;
        activeLibraryCatalogJobId = null;
    }
}

async function refreshTouchedLibrarySeries() {
    if (!touchedLibrarySeries.size) return;
    const seriesNames = [...touchedLibrarySeries];
    touchedLibrarySeries.clear();
    for (const series of seriesNames) {
        if (!db.prepare('SELECT 1 FROM library_series_state WHERE lower(series)=lower(?)').get(series)) continue;
        try { await scanLibrarySeriesDirectory(series); }
        catch (error) { log(`[LIBRARY INVENTORY] Could not refresh ${series} after processing: ${error.message}`, 'WARN'); }
    }
}

function startLibraryCatalogScan(reason = 'manual library inventory refresh') {
    const { destRoot } = getRoots();
    if (!destRoot || getPathPresence(destRoot) !== true) throw new Error('The configured manga library is unavailable. Check Settings → Test Paths.');
    const existing = db.prepare("SELECT id FROM library_catalog_jobs WHERE status IN ('queued','running') ORDER BY started_at DESC LIMIT 1").get();
    if (existing) {
        if (!libraryCatalogWorkerRunning) {
            db.prepare("UPDATE library_catalog_queue SET status='pending' WHERE job_id=? AND status='scanning'").run(existing.id);
            setImmediate(() => processLibraryCatalogJob(existing.id));
        }
        return catalogJobStatus(existing.id);
    }
    const folders = (fs.readdirSync(destRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && isLibrarySeriesFolderName(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const create = db.transaction(() => {
        db.prepare(`INSERT INTO library_catalog_jobs (id,status,total_series,done_series,error_count,reason,started_at,updated_at)
            VALUES (?, 'running', ?, 0, 0, ?, ?, ?)`).run(id, folders.length, String(reason).slice(0, 200), now, now);
        const insert = db.prepare("INSERT INTO library_catalog_queue (job_id, series, status) VALUES (?, ?, 'pending')");
        for (const folder of folders) insert.run(id, folder);
    });
    create();
    setImmediate(() => processLibraryCatalogJob(id));
    return catalogJobStatus(id);
}

function resumeLibraryCatalogScan() {
    const job = db.prepare("SELECT id FROM library_catalog_jobs WHERE status IN ('queued','running') ORDER BY started_at DESC LIMIT 1").get();
    if (!job) return null;
    db.prepare("UPDATE library_catalog_queue SET status='pending' WHERE job_id=? AND status='scanning'").run(job.id);
    setImmediate(() => processLibraryCatalogJob(job.id));
    return catalogJobStatus(job.id);
}

function distinctChapterCountSql(inventoryAlias = 'inventory', volumeSettingsAlias = 'volume_settings') {

    return `COUNT(DISTINCT CASE
        WHEN ${inventoryAlias}.is_special=0 AND ${inventoryAlias}.is_volume=0
            AND ${inventoryAlias}.chapter_number IS NOT NULL
            AND ${inventoryAlias}.chapter_key IS NOT NULL
            AND ${inventoryAlias}.chapter_number = CAST(${inventoryAlias}.chapter_number AS INTEGER)
            AND COALESCE(${inventoryAlias}.letter_suffix, '') = ''
            AND COALESCE(${volumeSettingsAlias}.volume_mode, 'off') <> 'volume-only'
        THEN CASE
            WHEN ${volumeSettingsAlias}.volume_mode = 'volume-chapters'
                THEN COALESCE(${inventoryAlias}.volume_key, '') || ':' || CAST(${inventoryAlias}.chapter_number AS INTEGER)
            ELSE CAST(${inventoryAlias}.chapter_number AS TEXT)
        END
    END)`;
}

function getLibraryOverviewStats() {

    const configStats = {
        trackedChapterCoverCount: Number(db.prepare(`SELECT COUNT(*) AS count
            FROM chapter_cover_insertions c
            INNER JOIN library_chapter_inventory i ON i.path=c.archive_path`).get()?.count || 0),
        comicInfoPolicy: getComicInfoPolicy()
    };
    const empty = {
        mangaCount: 0, scannedMangaCount: 0, mangaWithGaps: 0, totalChapters: 0,
        totalMissingChapterGaps: 0, duplicateChapterGroups: 0, unparsedFilenameCount: 0,
        completedMangaCount: 0, trackedSpecialCount: 0, volumeModeMangaCount: 0, completedMangaWithMissingChapters: 0, inventoryLastScannedAt: null, available: false,
        ...configStats
    };
    const { destRoot } = getRoots();
    if (!destRoot || getPathPresence(destRoot) !== true) return empty;
    let folders = [];
    try {
        folders = fs.readdirSync(destRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && isLibrarySeriesFolderName(entry.name))
            .map(entry => entry.name);
    } catch (_) { return empty; }

    const folderKeys = new Set(folders.map(folder => String(folder).toLowerCase()));
    const states = new Map(db.prepare(`SELECT series, completed, chapter_count, missing_count, duplicate_count, unparsed_count, special_count, last_scanned_at
        FROM library_series_state`).all().map(row => [String(row.series).toLowerCase(), row]));

    const completedMissingRows = db.prepare(`SELECT lower(series) AS series_key
        FROM library_completed_chapters WHERE missing_since IS NOT NULL
        GROUP BY lower(series)`).all();
    const completedMangaWithMissingChapters = completedMissingRows.filter(row =>
        folderKeys.has(row.series_key) && Boolean(states.get(row.series_key)?.completed)
    ).length;
    let scannedMangaCount = 0;
    let mangaWithGaps = 0;
    const inventoryChapterCounts = db.prepare(`SELECT lower(inventory.series) AS series_key,
            ${distinctChapterCountSql()} AS chapter_count
        FROM library_chapter_inventory AS inventory
        LEFT JOIN series_volume_settings AS volume_settings
            ON lower(volume_settings.series)=lower(inventory.series)
        GROUP BY lower(inventory.series)`).all();
    const totalChapters = inventoryChapterCounts.reduce((sum, row) =>
        sum + (folderKeys.has(row.series_key) ? Number(row.chapter_count || 0) : 0), 0);
    let totalMissingChapterGaps = 0;
    let duplicateChapterGroups = 0;
    let unparsedFilenameCount = 0;
    let completedMangaCount = 0;
    let trackedSpecialCount = 0;
    let volumeModeMangaCount = 0;
    let inventoryLastScannedAt = null;
    for (const folder of folders) {
        const state = states.get(folder.toLowerCase());
        if (state?.completed) completedMangaCount++;
        if (getSeriesVolumeMode(folder) !== 'off') volumeModeMangaCount++;
        if (!state?.last_scanned_at) continue;
        scannedMangaCount++;
        const missing = Number(state.missing_count || 0);
        if (missing > 0) mangaWithGaps++;
        totalMissingChapterGaps += missing;
        duplicateChapterGroups += Number(state.duplicate_count || 0);
        unparsedFilenameCount += Number(state.unparsed_count || 0);
        trackedSpecialCount += Number(state.special_count || 0);
        if (!inventoryLastScannedAt || String(state.last_scanned_at) > inventoryLastScannedAt) inventoryLastScannedAt = state.last_scanned_at;
    }
    return {
        ...empty,
        mangaCount: folders.length,
        scannedMangaCount,
        mangaWithGaps,
        totalChapters,
        totalMissingChapterGaps,
        duplicateChapterGroups,
        unparsedFilenameCount,
        completedMangaCount,
        trackedSpecialCount,
        volumeModeMangaCount,
        completedMangaWithMissingChapters,
        inventoryLastScannedAt,
        available: true
    };
}

async function listLibrarySeries() {
    const { destRoot } = getRoots();

    if (!destRoot) return { series: [], job: null, available: false, configured: false };
    if (getPathPresence(destRoot) !== true) throw new Error('The configured manga library is unavailable. Check Settings → Test Paths.');
    const folders = (await fs.readdir(destRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && isLibrarySeriesFolderName(entry.name))
        .map(entry => entry.name);
    const states = new Map(db.prepare('SELECT * FROM library_series_state').all().map(row => [row.series.toLowerCase(), row]));
    const pending = getSeriesPendingCounts();
    const specialCounts = new Map(db.prepare(`SELECT lower(series) AS series_key, COUNT(*) AS count
        FROM library_chapter_inventory WHERE is_special=1 GROUP BY lower(series)`).all()
        .map(row => [row.series_key, Number(row.count || 0)]));
    const completedMissingCounts = new Map(db.prepare(`SELECT lower(series) AS series_key, COUNT(*) AS count
        FROM library_completed_chapters WHERE missing_since IS NOT NULL GROUP BY lower(series)`).all()
        .map(row => [row.series_key, Number(row.count || 0)]));

    const inventoryCounts = new Map(db.prepare(`SELECT lower(inventory.series) AS series_key,
        COUNT(*) AS file_count,
${distinctChapterCountSql()} AS chapter_count
        FROM library_chapter_inventory AS inventory
        LEFT JOIN series_volume_settings AS volume_settings
            ON lower(volume_settings.series)=lower(inventory.series)
        GROUP BY lower(inventory.series)`).all()
        .map(row => [row.series_key, { fileCount: Number(row.file_count || 0), chapterCount: Number(row.chapter_count || 0) }]));
    const series = folders.map(name => {
        const state = states.get(name.toLowerCase()) || {};
        const inventory = inventoryCounts.get(name.toLowerCase()) || {};
        let specialsOnDisk = 0;
        try {
            specialsOnDisk = fs.readdirSync(path.join(destRoot, name, 'Specials'), { withFileTypes: true })
                .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz').length;
        } catch (_) {}
        return {
            series: name,
            completed: Boolean(state.completed),
            notes: state.notes || '',
            volumeMode: getSeriesVolumeMode(name),
            fileCount: Number(inventory.fileCount ?? state.file_count ?? 0),
            chapterCount: Number(inventory.chapterCount || 0),
            specialCount: Math.max(Number(specialCounts.get(name.toLowerCase()) || 0), specialsOnDisk),
            completedMissingCount: Number(completedMissingCounts.get(name.toLowerCase()) || 0),
            missingCount: Number(state.missing_count || 0),
            duplicateCount: Number(state.duplicate_count || 0),
            unparsedCount: Number(state.unparsed_count || 0),
            lastScannedAt: state.last_scanned_at || null,
            pendingCount: Number(pending[name] || 0),
            scanned: Boolean(state.last_scanned_at)
        };
    }).sort((a, b) => a.series.localeCompare(b.series, undefined, { numeric: true, sensitivity: 'base' }));
    let latestJob = catalogJobStatus();
    const stale = series.some(item => !item.scanned || !item.lastScannedAt || Date.now() - Date.parse(item.lastScannedAt) > 24 * 60 * 60 * 1000);
    const recentFailedScan = latestJob && ['failed', 'completed_with_errors'].includes(latestJob.status)
        && Date.now() - Date.parse(latestJob.finishedAt || latestJob.updatedAt || 0) < 6 * 60 * 60 * 1000;
    if (stale && !recentFailedScan && (!latestJob || !['queued', 'running'].includes(latestJob.status))) {
        latestJob = startLibraryCatalogScan('automatic inventory refresh for unscanned or stale manga folders');
    }
    return { series, job: latestJob, available: true, configured: true };
}

async function getLibrarySeriesDetail(series, { page = 0, limit = 50, kind = 'all' } = {}) {
    const { destRoot } = getRoots();
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    if (!isLibrarySeriesFolderName(validation.value)) throw new Error('This is a reserved metadata/system directory, not a manga series.');
    const seriesPath = path.resolve(destRoot, validation.value);
    if (!isWithin(destRoot, seriesPath) || samePath(destRoot, seriesPath) || getPathPresence(seriesPath) !== true) {
        throw new Error('The selected manga folder is not accessible in the configured library.');
    }
    const allowedKinds = new Set(['all', 'chapters', 'specials', 'volume-files', 'volume-chapters', 'unparsed', 'duplicates']);
    const safeKind = allowedKinds.has(String(kind || 'all')) ? String(kind || 'all') : 'all';
    let state = db.prepare('SELECT * FROM library_series_state WHERE lower(series)=lower(?)').get(validation.value);

    let specialsOnDisk = 0;
    try {
        specialsOnDisk = (await fs.readdir(path.join(seriesPath, 'Specials'), { withFileTypes: true }))
            .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz').length;
    } catch (_) {}
    let specialsInInventory = Number(db.prepare('SELECT COUNT(*) AS count FROM library_chapter_inventory WHERE lower(series)=lower(?) AND is_special=1').get(validation.value)?.count || 0);
    if (!state?.last_scanned_at || safeKind === 'specials' || specialsOnDisk !== specialsInInventory) {
        await scanLibrarySeriesDirectory(validation.value);
        state = db.prepare('SELECT * FROM library_series_state WHERE lower(series)=lower(?)').get(validation.value);
        specialsInInventory = Number(db.prepare('SELECT COUNT(*) AS count FROM library_chapter_inventory WHERE lower(series)=lower(?) AND is_special=1').get(validation.value)?.count || 0);
    }
    const safePage = Math.max(0, Number.parseInt(page, 10) || 0);
    const safeLimit = Math.max(10, Math.min(250, Number.parseInt(limit, 10) || 50));
    const kindClauses = {
        all: '',
        chapters: ' AND is_special=0 AND is_volume=0 AND chapter_key IS NOT NULL',
        specials: ' AND is_special=1',
        'volume-files': ' AND is_volume=1',
        'volume-chapters': " AND is_volume=0 AND is_special=0 AND volume_key IS NOT NULL AND volume_key <> '' AND chapter_key IS NOT NULL",
        unparsed: ' AND chapter_key IS NULL AND is_volume=0 AND is_special=0',
        duplicates: ` AND chapter_key IS NOT NULL AND EXISTS (
            SELECT 1 FROM library_chapter_inventory AS duplicate_rows
            WHERE duplicate_rows.series = library_chapter_inventory.series
              AND duplicate_rows.chapter_key = library_chapter_inventory.chapter_key
            GROUP BY duplicate_rows.series, duplicate_rows.chapter_key
            HAVING COUNT(*) > 1
        )`
    };
    const kindClause = kindClauses[safeKind];
    const filteredCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM library_chapter_inventory WHERE lower(series)=lower(?)${kindClause}`).get(validation.value)?.count || 0);
    const specialCount = Number(db.prepare('SELECT COUNT(*) AS count FROM library_chapter_inventory WHERE lower(series)=lower(?) AND is_special=1').get(validation.value)?.count || 0);
    const inventoryCounts = db.prepare(`SELECT COUNT(*) AS file_count,
${distinctChapterCountSql()} AS chapter_count
        FROM library_chapter_inventory AS inventory
        LEFT JOIN series_volume_settings AS volume_settings
            ON lower(volume_settings.series)=lower(inventory.series)
        WHERE lower(inventory.series)=lower(?)`).get(validation.value);
    const totalFiles = Number(inventoryCounts?.file_count || 0);
    const distinctChapterCount = Number(inventoryCounts?.chapter_count || 0);
    const pages = Math.max(1, Math.ceil(filteredCount / safeLimit));
    const actualPage = Math.min(safePage, pages - 1);
    const items = db.prepare(`SELECT path, series, file_name, chapter_key, chapter_label, chapter_number, letter_suffix, is_special,
            volume_key, volume_label, volume_number, volume_end_number, is_volume
        FROM library_chapter_inventory WHERE lower(series)=lower(?)${kindClause}
        ORDER BY is_special DESC, CASE WHEN volume_number IS NULL THEN 0 ELSE 1 END, volume_number,
            CASE WHEN chapter_number IS NULL THEN 1 ELSE 0 END, chapter_number,
            CASE WHEN letter_suffix='' THEN 0 ELSE 1 END, letter_suffix COLLATE NOCASE, pk_natural_key(file_name)
        LIMIT ? OFFSET ?`).all(validation.value, safeLimit, actualPage * safeLimit);
    const allNumeric = db.prepare(`SELECT DISTINCT chapter_number, letter_suffix, is_special, volume_key, volume_label, volume_number, volume_end_number, is_volume
        FROM library_chapter_inventory WHERE lower(series)=lower(?) AND (chapter_number IS NOT NULL OR volume_number IS NOT NULL)`).all(validation.value);
    const volumeMode = getSeriesVolumeMode(validation.value);
    const missing = calculateVolumeAwareMissingChapterNumbers(allNumeric, volumeMode);
    const missingTrackedChapters = state?.completed
        ? db.prepare(`SELECT identity_key, chapter_label, file_name, missing_since, notified_at
            FROM library_completed_chapters WHERE lower(series)=lower(?) AND missing_since IS NOT NULL
            ORDER BY missing_since, identity_key`).all(validation.value)
        : [];
    const duplicates = db.prepare(`SELECT chapter_key, COUNT(*) AS copies FROM library_chapter_inventory
        WHERE lower(series)=lower(?) AND chapter_key IS NOT NULL GROUP BY chapter_key HAVING COUNT(*) > 1
        ORDER BY pk_natural_key(MIN(chapter_label))`).all(validation.value);
    return {
        series: validation.value,
        completed: Boolean(state?.completed),
        notes: state?.notes || '',
        volumeMode,
        fileCount: totalFiles,
        chapterCount: distinctChapterCount,
        missingCount: missing.count,
        missingChapters: missing.missing,
        missingRanges: missing.ranges,
        duplicateCount: duplicates.length,
        duplicateGroups: duplicates,
        unparsedCount: Number(state?.unparsed_count || 0),
        specialCount,
        missingTrackedChapters,
        missingTrackedCount: missingTrackedChapters.length,
        filteredCount,
        filterKind: safeKind,
        lastScannedAt: state?.last_scanned_at || null,
        items: items.map(item => ({ ...item, duplicate: Boolean(item.chapter_key && duplicates.some(group => group.chapter_key === item.chapter_key)) })),
        total: filteredCount, page: actualPage, limit: safeLimit, pages
    };
}

function setLibrarySeriesMetadata(series, { completed, notes, volumeMode } = {}) {
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM library_series_state WHERE lower(series)=lower(?)').get(validation.value);
    const nextCompleted = completed === undefined ? Boolean(existing?.completed) : Boolean(completed);
    const updateState = db.prepare(`INSERT INTO library_series_state
        (series, completed, notes, file_count, chapter_count, missing_count, duplicate_count, unparsed_count, last_scanned_at, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, NULL, ?)
        ON CONFLICT(series) DO UPDATE SET completed=excluded.completed, notes=excluded.notes, updated_at=excluded.updated_at`);
    const currentNotes = notes === undefined ? String(existing?.notes || '') : String(notes).slice(0, 2000);
    db.transaction(() => {
        updateState.run(validation.value, nextCompleted ? 1 : 0, currentNotes, now);
        if (completed === false) {
            db.prepare('DELETE FROM library_completed_chapters WHERE lower(series)=lower(?)').run(validation.value);
            db.prepare('DELETE FROM library_completion_tracking WHERE lower(series)=lower(?)').run(validation.value);
        } else if (completed === true) {
            const tracking = db.prepare('SELECT * FROM library_completion_tracking WHERE lower(series)=lower(?)').get(validation.value);
            if (!existing?.completed || !tracking) {
                db.prepare('DELETE FROM library_completed_chapters WHERE lower(series)=lower(?)').run(validation.value);
                const baselineReady = Boolean(existing?.last_scanned_at);
                db.prepare(`INSERT INTO library_completion_tracking (series, baseline_ready, created_at, updated_at)
                    VALUES (?, ?, ?, ?) ON CONFLICT(series) DO UPDATE SET baseline_ready=excluded.baseline_ready, updated_at=excluded.updated_at`)
                    .run(validation.value, baselineReady ? 1 : 0, now, now);
                if (baselineReady) {
                    const currentRecords = db.prepare(`SELECT chapter_key, chapter_label, file_name
                        FROM library_chapter_inventory WHERE lower(series)=lower(?)`).all(validation.value);
                    seedCompletedChapterSnapshot(validation.value, currentRecords, now);
                }
            }
        }
    })();
    if (volumeMode !== undefined) setSeriesVolumeMode(validation.value, volumeMode);
    const state = db.prepare('SELECT * FROM library_series_state WHERE lower(series)=lower(?)').get(validation.value);
    if (completed !== undefined) {
        log(`${validation.value} marked ${completed ? 'complete' : 'ongoing'}. ${completed ? 'Existing chapters are protected from automatic replacement, and their identities are tracked for missing-file alerts.' : 'Completion tracking is disabled and normal automatic upgrade rules are restored.'}`);
    }
    return { success: true, completed: Boolean(state.completed), notes: state.notes, volumeMode: getSeriesVolumeMode(validation.value) };
}

function rebaseStoredPath(value, oldRoot, newRoot) {
    if (!value || !isWithin(oldRoot, value)) return value;
    return path.resolve(newRoot, path.relative(oldRoot, value));
}

async function waitForLibrarySeriesScan(series) {
    while (activeLibraryCatalogSeries && activeLibraryCatalogSeries.toLowerCase() === String(series || '').toLowerCase()) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function refreshLibrarySeriesForCompletion(series) {
    await yieldToPipeline();
    await waitForLibrarySeriesScan(series);
    return scanLibrarySeriesDirectory(series);
}

async function renameLibrarySeries(oldName, newName) {
    const { destRoot } = getRoots();
    const oldValidation = validateSeriesName(oldName);
    const newValidation = validateSeriesName(newName);
    if (!oldValidation.valid) throw new Error(oldValidation.message);
    if (!newValidation.valid) throw new Error(newValidation.message);
    if (oldValidation.value.toLocaleLowerCase() === newValidation.value.toLocaleLowerCase()) {
        return { success: true, message: 'The manga folder already has that name.', merged: false };
    }

    await yieldToPipeline();
    await waitForLibrarySeriesScan(oldValidation.value);
    await waitForLibrarySeriesScan(newValidation.value);
    await waitForCoverMutations();
    beginQcMutation();
    let mergeResult = null;
    let wasSimpleRename = false;
    let oldRoot = '';
    let newRoot = '';
    try {
        oldRoot = path.resolve(destRoot, oldValidation.value);
        newRoot = path.resolve(destRoot, newValidation.value);
        if (!destRoot || !isWithin(destRoot, oldRoot) || !isWithin(destRoot, newRoot) || samePath(oldRoot, destRoot) || samePath(newRoot, destRoot)) {
            throw new Error('Unsafe manga folder path.');
        }
        if (getPathPresence(oldRoot) !== true) throw new Error('The existing manga folder is not accessible.');
        const targetPresence = getPathPresence(newRoot);
        if (targetPresence === false) {
            await fs.rename(oldRoot, newRoot);
            wasSimpleRename = true;
        } else if (targetPresence === true) {
            const targetStat = await fs.stat(newRoot).catch(() => null);
            if (!targetStat?.isDirectory()) throw new Error('The destination name is occupied by a file, not a manga folder.');
            mergeResult = await libraryMergeUtils.mergeDirectoryContents(oldRoot, newRoot);
        } else {
            throw new Error('The destination folder could not be safely checked. No files were moved.');
        }

        const pathMap = mergeResult?.pathMap || new Map();
        const mapPath = value => {
            if (!value) return value;
            const mapped = libraryMergeUtils.mapMergedPath(value, pathMap);
            return mapped !== path.resolve(String(value)) ? mapped : rebaseStoredPath(value, oldRoot, newRoot);
        };
        const now = new Date().toISOString();
        const mappingsUpdated = Number(db.prepare('SELECT COUNT(*) AS count FROM series_mappings WHERE lower(target_series)=lower(?)').get(oldValidation.value)?.count || 0);
        const pathTables = [
            ['processed_files', 'path'], ['chapter_overrides', 'path'], ['file_issues', 'path'],
            ['pending_conflicts', 'source_path'], ['pending_conflicts', 'destination_path'],
            ['cover_insertions', 'archive_path'], ['cover_insertions', 'cover_path'],
            ['series_cover_rules', 'cover_path'], ['cover_update_jobs', 'cover_path'],
            ['cover_update_items', 'archive_path'], ['series_chapter_cover_designs', 'source_path'],
            ['chapter_cover_insertions', 'archive_path'], ['chapter_cover_insertions', 'source_path'],
            ['chapter_cover_job_items', 'archive_path'], ['recovery_items', 'original_path'],
            ['recovery_items', 'backup_path'], ['library_chapter_inventory', 'path']
        ];
        const migrateDbPaths = db.transaction(() => {
            for (const [table, column] of pathTables) {
                const rows = db.prepare(`SELECT rowid AS _rowid, "${column}" AS value FROM "${table}" WHERE substr("${column}", 1, length(?)) = ?`).all(path.join(oldRoot, ''), path.join(oldRoot, ''));
                const update = db.prepare(`UPDATE "${table}" SET "${column}"=? WHERE rowid=?`);
                for (const row of rows) update.run(mapPath(row.value), row._rowid);
            }

            db.prepare('UPDATE series_mappings SET target_series=? WHERE lower(target_series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE pending_conflicts SET target_series=? WHERE lower(target_series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE file_issues SET target_series=? WHERE lower(target_series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE recovery_items SET series=? WHERE lower(series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE cover_insertions SET series=? WHERE lower(series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE cover_update_jobs SET series=? WHERE lower(series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE chapter_cover_insertions SET series=? WHERE lower(series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE chapter_cover_jobs SET series=? WHERE lower(series)=lower(?)').run(newValidation.value, oldValidation.value);
            db.prepare('UPDATE library_chapter_inventory SET series=? WHERE lower(series)=lower(?)').run(newValidation.value, oldValidation.value);
            const oldCompletionTracking = db.prepare('SELECT * FROM library_completion_tracking WHERE lower(series)=lower(?)').get(oldValidation.value);
            const targetCompletionTracking = db.prepare('SELECT * FROM library_completion_tracking WHERE lower(series)=lower(?)').get(newValidation.value);
            if (oldCompletionTracking) {
                if (targetCompletionTracking) {
                    db.prepare(`INSERT OR IGNORE INTO library_completed_chapters
                        (series, identity_key, chapter_label, file_name, first_seen_at, last_seen_at, missing_since, notified_at, last_attempt_at)
                        SELECT ?, identity_key, chapter_label, file_name, first_seen_at, last_seen_at, missing_since, notified_at, last_attempt_at
                        FROM library_completed_chapters WHERE lower(series)=lower(?)`).run(newValidation.value, oldValidation.value);
                    db.prepare('UPDATE library_completion_tracking SET baseline_ready=MAX(baseline_ready, ?), updated_at=? WHERE lower(series)=lower(?)')
                        .run(oldCompletionTracking.baseline_ready, now, newValidation.value);
                    db.prepare('DELETE FROM library_completed_chapters WHERE lower(series)=lower(?)').run(oldValidation.value);
                    db.prepare('DELETE FROM library_completion_tracking WHERE lower(series)=lower(?)').run(oldValidation.value);
                } else {
                    db.prepare('UPDATE library_completion_tracking SET series=?, updated_at=? WHERE lower(series)=lower(?)')
                        .run(newValidation.value, now, oldValidation.value);
                    db.prepare('UPDATE library_completed_chapters SET series=? WHERE lower(series)=lower(?)')
                        .run(newValidation.value, oldValidation.value);
                }
            }
            db.prepare("UPDATE library_catalog_queue SET series=? WHERE lower(series)=lower(?) AND status IN ('pending','scanning')")
                .run(newValidation.value, oldValidation.value);

            const movePrimarySetting = (table, keyColumn) => {
                const oldRow = db.prepare(`SELECT "${keyColumn}" AS key FROM "${table}" WHERE lower("${keyColumn}")=lower(?)`).get(oldValidation.value);
                if (!oldRow) return;
                const target = db.prepare(`SELECT 1 FROM "${table}" WHERE lower("${keyColumn}")=lower(?)`).get(newValidation.value);
                if (target) db.prepare(`DELETE FROM "${table}" WHERE lower("${keyColumn}")=lower(?)`).run(oldValidation.value);
                else db.prepare(`UPDATE "${table}" SET "${keyColumn}"=? WHERE lower("${keyColumn}")=lower(?)`).run(newValidation.value, oldValidation.value);
            };
            movePrimarySetting('series_cover_rules', 'target_series');
            movePrimarySetting('series_kavita_cover_sources', 'target_series');
            movePrimarySetting('series_chapter_cover_designs', 'target_series');
            renameSeriesVolumeMode(oldValidation.value, newValidation.value);
            renameSeriesIgnoredTerms(oldValidation.value, newValidation.value);

            const oldState = db.prepare('SELECT * FROM library_series_state WHERE lower(series)=lower(?)').get(oldValidation.value);
            if (oldState) {
                const targetState = db.prepare('SELECT * FROM library_series_state WHERE lower(series)=lower(?)').get(newValidation.value);
                if (targetState) {
                    const notes = [...new Set([targetState.notes, oldState.notes].map(value => String(value || '').trim()).filter(Boolean))].join('\n\n');
                    db.prepare(`UPDATE library_series_state SET completed=MAX(completed, ?), notes=?, last_scanned_at=NULL, updated_at=? WHERE lower(series)=lower(?)`)
                        .run(oldState.completed, notes, now, newValidation.value);
                    db.prepare('DELETE FROM library_series_state WHERE lower(series)=lower(?)').run(oldValidation.value);
                } else {
                    db.prepare('UPDATE library_series_state SET series=?, last_scanned_at=NULL, updated_at=? WHERE lower(series)=lower(?)')
                        .run(newValidation.value, now, oldValidation.value);
                }
            }

            db.prepare(`INSERT OR IGNORE INTO series_special_numbers
                (series, special_key, special_number, special_title, created_at, updated_at)
                SELECT ?, special_key, special_number, special_title, created_at, updated_at
                FROM series_special_numbers WHERE lower(series)=lower(?)`).run(newValidation.value, oldValidation.value);
            db.prepare('DELETE FROM series_special_numbers WHERE lower(series)=lower(?)').run(oldValidation.value);

            const templateSetting = db.prepare('SELECT value FROM settings WHERE key=?').get('comicInfoSeriesTemplates');
            if (templateSetting?.value) {
                try {
                    const templates = JSON.parse(String(templateSetting.value));
                    if (templates && typeof templates === 'object' && !Array.isArray(templates)) {
                        const oldKey = Object.keys(templates).find(key => key.toLocaleLowerCase() === oldValidation.value.toLocaleLowerCase());
                        const newKey = Object.keys(templates).find(key => key.toLocaleLowerCase() === newValidation.value.toLocaleLowerCase());
                        if (oldKey) {
                            if (!newKey) templates[newValidation.value] = templates[oldKey];
                            delete templates[oldKey];
                            db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
                                .run('comicInfoSeriesTemplates', JSON.stringify(templates));
                        }
                    }
                } catch (error) {
                    log(`[COMICINFO TEMPLATE] Could not migrate the per-manga template during rename: ${error.message}`, 'WARN');
                }
            }
        });

        try {
            migrateDbPaths();
        } catch (error) {
            if (mergeResult) await libraryMergeUtils.rollbackDirectoryMerge(mergeResult).catch(() => {});
            else if (wasSimpleRename) await fs.rename(newRoot, oldRoot).catch(() => {});
            throw new Error(`The manga folder ${mergeResult ? 'merge' : 'rename'} could not be saved to the main database. The file operation was rolled back where possible. ${error.message}`);
        }

        let qcPathMigrationWarning = '';
        try {
            const oldPrefix = path.join(oldRoot, '');
            const qcRows = qcDb.prepare('SELECT rowid AS _rowid, path FROM qc_cache WHERE substr(path, 1, length(?)) = ?').all(oldPrefix, oldPrefix);
            const qcDirectoryRows = qcDb.prepare('SELECT id, path FROM qc_scan_dirs WHERE substr(path, 1, length(?)) = ?').all(oldPrefix, oldPrefix);
            const updateQcPath = qcDb.prepare('UPDATE OR REPLACE qc_cache SET path=? WHERE rowid=?');
            const updateQcDirectory = qcDb.prepare('UPDATE OR REPLACE qc_scan_dirs SET path=? WHERE id=?');
            qcDb.transaction(() => {
                for (const row of qcRows) updateQcPath.run(mapPath(row.path), row._rowid);
                for (const row of qcDirectoryRows) updateQcDirectory.run(mapPath(row.path), row.id);
            })();
        } catch (error) {
            qcPathMigrationWarning = ` The QC cache could not be fully migrated and will be refreshed on its next scan: ${error.message}`;
            log(`[LIBRARY ${mergeResult ? 'MERGE' : 'RENAME'}] QC cache path migration deferred: ${error.message}`, 'WARN');
        }

        try { await scanLibrarySeriesDirectory(newValidation.value); }
        catch (error) { log(`[LIBRARY ${mergeResult ? 'MERGE' : 'RENAME'}] Inventory refresh was deferred: ${error.message}`, 'WARN'); }

        let conflictsCreated = 0;
        if (mergeResult?.movedFiles?.length) {
            const seen = new Set();
            for (const movedFile of mergeResult.movedFiles) {
                const chapter = parseSeriesChapter(path.basename(movedFile.sourcePath), newValidation.value);
                if (!chapter || !(await fs.pathExists(movedFile.targetPath))) continue;
                const collision = await findChapterCollision(newRoot, newValidation.value, chapter, movedFile.targetPath);
                if (!collision) continue;
                const pair = [path.resolve(movedFile.targetPath), path.resolve(collision)].sort().join('|');
                if (seen.has(pair)) continue;
                seen.add(pair);
                savePendingConflict(movedFile.targetPath, collision, newValidation.value, chapter,
                    `Folder merge preserved two files that map to ${chapter.label}. Compare the versions and choose which should remain active.`);
                conflictsCreated++;
            }
        }

        let comicInfoRenameResult = null;
        let comicInfoRenameWarning = '';
        if (getComicInfoPolicy(newValidation.value) === 'update') {
            try {
                comicInfoRenameResult = await applyComicInfoPolicyToSeries(newValidation.value, 'update');
                log(`[COMICINFO UPDATE] Manga ${mergeResult ? 'merge' : 'rename'} synchronized metadata: ${comicInfoRenameResult.changed} updated; ${comicInfoRenameResult.skipped} unchanged; ${comicInfoRenameResult.errors} errors.`);
                if (comicInfoRenameResult.errors) comicInfoRenameWarning = ` ComicInfo name synchronization had ${comicInfoRenameResult.errors} error(s); see logs and QC.`;
            } catch (error) {
                comicInfoRenameWarning = ` ComicInfo name synchronization could not run: ${error.message}`;
                log(`[COMICINFO UPDATE] Manga ${mergeResult ? 'merge' : 'rename'} completed, but metadata synchronization failed: ${error.message}`, 'WARN');
            }
        }
        if (mergeResult) {
            log(`Merged manga folder "${oldValidation.value}" into "${newValidation.value}"; ${mergeResult.moved} file(s) moved, ${mergeResult.renamed} collision(s) retained with unique names, ${conflictsCreated} chapter conflict(s) queued.`);
        } else {
            log(`Renamed manga folder "${oldValidation.value}" to "${newValidation.value}"; linked mappings and tracked paths were updated.`);
        }
        return {
            success: true,
            merged: Boolean(mergeResult),
            movedFiles: Number(mergeResult?.moved || 0),
            renamedCollisions: Number(mergeResult?.renamed || 0),
            conflictsCreated,
            oldName: oldValidation.value,
            newName: newValidation.value,
            mappingsUpdated,
            comicInfoUpdated: Number(comicInfoRenameResult?.changed || 0),
            message: mergeResult
                ? `Merged "${oldValidation.value}" into "${newValidation.value}". Moved ${mergeResult.moved} file(s); retained ${mergeResult.renamed} filename collision(s) using [merged] names. ${conflictsCreated} chapter conflict(s) were queued for review. No existing files were overwritten. Updated ${mappingsUpdated} mapping(s), cover settings, completion state, metadata templates, Recovery references, and tracked paths. Original provider source titles and download paths were preserved.${comicInfoRenameResult ? ` ComicInfo identity fields updated in ${comicInfoRenameResult.changed} CBZ file(s).` : ''}${comicInfoRenameWarning}${qcPathMigrationWarning}`
                : `Renamed manga folder to ${newValidation.value}. Updated ${mappingsUpdated} saved mapping(s), cover rules, completion status, pending queues, Recovery references, and tracked file paths. Original provider source titles and download paths were preserved.${comicInfoRenameResult ? ` ComicInfo identity fields updated in ${comicInfoRenameResult.changed} CBZ file(s).` : ''}${comicInfoRenameWarning}${qcPathMigrationWarning}`
        };
    } finally {
        endQcMutation();
    }
}

function parseChapterRangeInput(value, volumeMode = 'off') {
    const text = String(value || '').trim();
    let volumeKey = '';
    let rangeText = text;
    const colon = text.match(/^(.+?)\s*[:：]\s*(\d+(?:\.\d+)?[a-z]?)\s*(?:\.\.|-)\s*(\d+(?:\.\d+)?[a-z]?)$/i);
    if (colon) {
        const volume = parseChapter(`${colon[1]}.cbz`, '', { volumeMode: 'volume-only' });
        if (!volume?.volumeKey) return null;
        volumeKey = volume.volumeKey;
        rangeText = `${colon[2]}-${colon[3]}`;
    }
    const match = rangeText.match(/^(\d+(?:\.\d+)?[a-z]?)\s*(?:\.\.|-)\s*(\d+(?:\.\d+)?[a-z]?)$/i);
    if (!match) return null;
    const parseBound = token => {
        const parsed = token.match(/^(\d+(?:\.\d+)?)([a-z]?)$/i);
        return { number: Number(parsed[1]), suffix: String(parsed[2] || '').toLowerCase() };
    };
    const start = parseBound(match[1]), end = parseBound(match[2]);
    if (!Number.isFinite(start.number) || !Number.isFinite(end.number) || start.number > end.number) return null;
    return { start, end, volumeKey, volumeRange: volumeMode === 'volume-only' && !volumeKey };
}

function compareChapterPosition(chapter, bound) {
    if (chapter.number !== bound.number) return chapter.number < bound.number ? -1 : 1;
    const suffix = String(chapter.letterSuffix || '').toLowerCase();
    if (suffix === bound.suffix) return 0;
    if (!suffix) return bound.suffix ? -1 : 0;
    if (!bound.suffix) return 1;
    return suffix.localeCompare(bound.suffix);
}

async function deleteLibraryChaptersToRecovery(series, rangeText) {
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot, validation.value);
    if (getPathPresence(seriesPath) !== true) throw new Error('The manga folder is not accessible.');
    const volumeMode = getSeriesVolumeMode(validation.value);
    const range = parseChapterRangeInput(rangeText, volumeMode);
    const exact = range ? null : parseChapterLabel(rangeText, { volumeMode });
    if (!range && !exact) throw new Error('Enter one chapter such as 17.1 or a numeric range such as 12-20. Specials can be renamed individually but are not included in numeric ranges.');
    if (volumeMode === 'volume-chapters' && (range || exact) && !(range?.volumeKey || exact?.volumeKey)) {
        throw new Error('This manga tracks chapters separately by volume. Include the volume to avoid removing the same chapter numbers from every volume. Example: Volume 02: 12-20.');
    }
    await yieldToPipeline();
    await waitForLibrarySeriesScan(validation.value);
    beginQcMutation();
    try {
        const matches = [];
        for (const fullPath of await listSeriesChapterFiles(seriesPath)) {
            const entryName = path.basename(fullPath);
            const chapter = parseSeriesChapter(entryName, validation.value);
            if (!chapter) continue;
            let match = false;
            if (range && !chapter.special && volumeMode === 'volume-only') {
                const start = range.start.number;
                const end = range.end.number;
                const volumeStart = Number(chapter.volumeNumber ?? chapter.number);
                const volumeEnd = Number(chapter.volumeEndNumber ?? chapter.volumeNumber ?? chapter.number);
                match = Number.isFinite(volumeStart) && Number.isFinite(volumeEnd) && volumeStart <= end && volumeEnd >= start;
            } else if (range && !chapter.special && Number.isFinite(Number(chapter.number))) {
                const sameVolume = !range.volumeKey || String(chapter.volumeKey || '') === String(range.volumeKey);
                match = sameVolume && compareChapterPosition(chapter, range.start) >= 0 && (compareChapterPosition(chapter, range.end) <= 0 || (!range.end.suffix && Number(chapter.number) === range.end.number));
            } else if (exact) {
                match = chapter.key === exact.key;
            }
            if (match) matches.push({ path: fullPath, chapter });
        }
        if (!matches.length) throw new Error(`No chapter files matched "${rangeText}". Nothing was moved.`);
        const moved = [];
        for (const item of matches) moved.push(await createRecoveryForPath(item.path, validation.value));
        await scanLibrarySeriesDirectory(validation.value);
        log(`Moved ${moved.length} selected chapter file(s) from ${validation.value} into Recovery (${rangeText}).`);
        return { success: true, count: moved.length, message: `${moved.length} chapter file(s) moved to Recovery. They can be restored from the Recovery tab.` };
    } finally {
        endQcMutation();
    }
}

async function renameLibraryChapter(series, filePath, chapterInput) {
    const validation = validateSeriesName(series);
    if (!validation.valid) throw new Error(validation.message);
    const { destRoot } = getRoots();
    const seriesPath = path.resolve(destRoot, validation.value);
    const source = path.resolve(String(filePath || ''));
    const allowedSourceParent = samePath(path.dirname(source), seriesPath)
        || samePath(path.dirname(source), path.join(seriesPath, 'Specials'));
    if (!isWithin(seriesPath, source) || !allowedSourceParent || path.extname(source).toLowerCase() !== '.cbz') throw new Error('The selected CBZ is not a direct chapter inside this manga or its Specials subfolder.');
    if (getPathPresence(source) !== true) throw new Error('The selected chapter file is not accessible.');
    const sourceChapter = parseSeriesChapter(path.basename(source), validation.value);
    const parsedOverride = parseSeriesChapterLabel(chapterInput, validation.value);
    const parsed = resolveChapterOverride(sourceChapter, parsedOverride, parsedOverride ? { chapter_label: parsedOverride.label, chapter_key: parsedOverride.key } : null, validation.value);
    if (!parsed) throw new Error('Enter a valid chapter label such as 17.1, 124b, Volume 02 Chapter 17, or Special Creators Notes.');
    await yieldToPipeline();
    await waitForLibrarySeriesScan(validation.value);
    beginQcMutation();
    try {
        const destination = buildChapterDestination(seriesPath, validation.value, parsed);
        await fs.ensureDir(destination.directory);
        const target = destination.path;
        if (!samePath(source, target) && getPathPresence(target) === true) throw new Error(`The destination already exists: ${path.basename(target)}. No file was overwritten.`);
        if (!samePath(source, target)) await fs.move(source, target, { overwrite: false });
        const now = new Date().toISOString();
        const update = db.transaction(() => {
            db.prepare('UPDATE processed_files SET path=? WHERE path=?').run(path.resolve(target), source);
            db.prepare('UPDATE chapter_overrides SET path=?, chapter_label=?, chapter_key=? WHERE path=?')
                .run(path.resolve(target), parsed.label, parsed.key, source);
            db.prepare('UPDATE file_issues SET path=?, reason=?, updated_at=? WHERE path=?')
                .run(path.resolve(target), `Manually renamed to ${path.basename(target)}.`, now, source);
            db.prepare('UPDATE cover_insertions SET archive_path=? WHERE archive_path=?').run(path.resolve(target), source);
            db.prepare('UPDATE pending_conflicts SET source_path=? WHERE source_path=? AND status=\'pending\'').run(path.resolve(target), source);
        });
        update();
        qcDb.prepare('UPDATE qc_cache SET path=? WHERE path=?').run(path.resolve(target), source);
        if (!db.prepare('SELECT 1 FROM chapter_overrides WHERE path=?').get(path.resolve(target))) {
            db.prepare('INSERT INTO chapter_overrides (path,chapter_label,chapter_key,created_at) VALUES (?,?,?,?)')
                .run(path.resolve(target), parsed.label, parsed.key, now);
        }
        let metadataUpdated = false;
        if (getComicInfoPolicy(validation.value) === 'update') {
            try {
                const metadataResult = await applyComicInfoUpdateToArchive(target, validation.value, parsed);
                metadataUpdated = Boolean(metadataResult.changed);
            } catch (error) {
                log(`[COMICINFO UPDATE] Chapter rename completed, but metadata could not be synchronized for ${path.basename(target)}: ${error.message}`, 'WARN');
            }
        }
        await scanLibrarySeriesDirectory(validation.value);
        log(`Renamed library chapter: ${path.basename(source)} -> ${path.basename(target)}.${metadataUpdated ? ' ComicInfo identity fields updated.' : ''}`);
        return { success: true, metadataUpdated, message: `Renamed to ${path.basename(target)}.${metadataUpdated ? ' ComicInfo.xml was updated to match the new chapter identity.' : ''}` };
    } finally {
        endQcMutation();
    }
}

function parseQcChapterPath(filePath, series) {
    const base = portableBasename(filePath);
    const parsed = parseSeriesChapter(base, series);
    const { destRoot } = getRoots();
    if (!destRoot || !series) return parsed;
    const specialsPath = path.join(path.resolve(destRoot, series), 'Specials');
    const isInSpecials = samePath(path.dirname(path.resolve(filePath)), specialsPath);
    if (!isInSpecials || parsed?.special) return parsed;

    let title = base.replace(/\.(?:cbz|zip)$/i, '');
    const escaped = String(series).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`^${escaped}\\s*[-_: ]*`, 'i'), '').trim();
    title = title.replace(/^(?:chapter|chap|chp|ch|c|episode|ep)\s*\.?\s*\d+(?:\.\d+)?[a-z]?\s*[-_: ]*/i, '').trim();
    if (!title) return parseSeriesChapterLabel('Special', series);
    return parseSeriesChapterLabel(`Special - ${title}`, series) || {
        label: `Special ${title}`,
        key: `special:${slugSpecialKey(title)}`,
        number: null,
        specialNumber: null,
        specialTitle: title,
        additionalText: title,
        special: true
    };
}

function hasCorrectName(filePath, series) {
    const fileName = path.basename(filePath);
    return fileName.toLowerCase().startsWith(`${series} - `.toLowerCase());
}

async function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function collectDirectoryDuplicateGroups(dirPath, destRoot, generationAtStart) {
    const groups = new Map();
    let visited = 0;
    if (!(await fs.pathExists(dirPath))) return { groups, interrupted: false };
    const directory = await require('fs').promises.opendir(dirPath);
    for await (const entry of directory) {
        if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== generationAtStart) return { groups, interrupted: true };
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.cbz') continue;
        const filePath = path.join(dirPath, entry.name);
        const series = seriesNameFromPath(filePath, destRoot);
        const chapter = parseSeriesChapter(entry.name, series);
        if (chapter) {
            const group = groups.get(chapter.key) || [];
            group.push({
                path: filePath,
                name: entry.name,
                series,
                chapter,
                copyNumber: extractDownloaderCopyNumber(entry.name),
                mtime: 0
            });
            groups.set(chapter.key, group);
        }
        visited++;
        if (visited % 100 === 0) {
            await new Promise(resolve => setImmediate(resolve));
            if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== generationAtStart) return { groups, interrupted: true };
        }
    }

    let candidates = 0;
    for (const entries of groups.values()) {
        if (entries.length < 2) continue;
        for (const item of entries) {
            if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== generationAtStart) return { groups, interrupted: true };
            const stats = await fs.stat(item.path).catch(() => null);
            if (!stats) continue;
            item.mtime = stats.mtimeMs || 0;
            item.size = stats.size;
            candidates++;
            if (candidates % 100 === 0) {
                await new Promise(resolve => setImmediate(resolve));
                if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== generationAtStart) return { groups, interrupted: true };
            }
        }
    }
    return { groups, interrupted: false };
}

async function processDirectoryDuplicateGroups(groups, { generationAtStart } = {}) {
    const { destRoot } = getRoots();
    if (!destRoot) return { archived: 0, flagged: 0, interrupted: false };
    let archived = 0;
    let flagged = 0;
    for (const [chapterKey, entries] of groups) {
        const hasCopyCounter = entries.some(item => item.copyNumber !== null);

        if (entries.length < 2 && !hasCopyCounter) continue;
        let keepers = [];
        let losers = [];

        if (hasCopyCounter) {

            const sorted = rankDownloaderCopies(entries);
            keepers = [sorted[0]];
            losers = sorted.slice(1);
        } else {

            const byHash = new Map();
            for (const item of entries) {
                if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                    return { archived, flagged, interrupted: true };
                }
                await yieldToPipeline();
                if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                    return { archived, flagged, interrupted: true };
                }
                let digest;
                try { digest = await hashFile(item.path); }
                catch (error) {
                    digest = `unreadable:${item.path}`;
                    log(`[QC DUPLICATE CHECK] Could not hash ${path.basename(item.path)}: ${error.message}`, 'WARN');
                }
                const same = byHash.get(digest) || [];
                same.push(item);
                byHash.set(digest, same);
            }
            const distinctContent = [];
            for (const identical of byHash.values()) {
                identical.sort((a, b) => b.mtime - a.mtime);
                keepers.push(identical[0]);
                losers.push(...identical.slice(1));
                distinctContent.push(identical[0]);
            }

            if (distinctContent.length > 1) {
                const representative = distinctContent[0];
                const activeConflict = db.prepare(`SELECT 1 FROM pending_conflicts
                    WHERE status='pending' AND lower(target_series)=lower(?) AND chapter_key=? LIMIT 1`)
                    .get(representative.series, chapterKey);
                const pendingManualAttention = distinctContent.some(item => db.prepare(`SELECT 1 FROM file_issues
                    WHERE status='pending' AND kind='manual_chapter' AND path=? LIMIT 1`).get(path.resolve(item.path)));
                if (!activeConflict && !pendingManualAttention) {
                    const pairKeys = new Set();
                    for (let index = 1; index < distinctContent.length; index++) {
                        const left = distinctContent[index - 1];
                        const right = distinctContent[index];
                        if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                            return { archived, flagged, interrupted: true };
                        }
                        const leftExists = await fs.pathExists(left.path);
                        const rightExists = await fs.pathExists(right.path);
                        if (!leftExists || !rightExists) continue;
                        const pair = [path.resolve(left.path), path.resolve(right.path)].sort().join('|');
                        if (pairKeys.has(pair)) continue;
                        pairKeys.add(pair);
                        const conflictId = savePendingConflict(right.path, left.path, right.series, right.chapter,
                            `Multiple non-identical archives map to ${right.chapter.label}. QC kept both files and transferred the choice to Chapter Conflicts.`);
                        flagged++;
                        log(`[QC → CONFLICT #${conflictId}] Non-identical copies of ${right.chapter.label} were preserved for comparison.`, 'WARN');
                    }
                }
                for (const item of distinctContent) clearQcIssueFlag(item.path, 'duplicate_chapter');
            } else {
                for (const item of distinctContent) clearQcIssueFlag(item.path, 'duplicate_chapter');
            }
        }

        for (const loser of losers) {
            if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                return { archived, flagged, interrupted: true };
            }
            await yieldToPipeline();
            if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                return { archived, flagged, interrupted: true };
            }
            const loserExists = await fs.pathExists(loser.path);
            if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                return { archived, flagged, interrupted: true };
            }
            if (!loserExists) continue;
            beginQcMutation();
            try {

                await createRecoveryForPath(loser.path, loser.series);
                qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(path.resolve(loser.path));
                db.prepare('DELETE FROM processed_files WHERE path=?').run(path.resolve(loser.path));
                archived++;
                log(`[QC DUPLICATE REMOVED] Kept ${path.basename((keepers[0] || loser).path)} and moved duplicate ${path.basename(loser.path)} to Recovery (${chapterKey}).`);
            } catch (error) {
                log(`[QC DUPLICATE ERROR] ${path.basename(loser.path)}: ${error.message}`, 'ERROR');
            } finally {
                endQcMutation();
            }
        }

        if (pipelinePromise || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
            return { archived, flagged, interrupted: true };
        }
        if (hasCopyCounter && keepers[0]) {
            const keeper = keepers[0];
            const keeperSeriesPath = path.resolve(destRoot, keeper.series);
            const canonicalPath = buildChapterDestination(keeperSeriesPath, keeper.series, { ...keeper.chapter }).path;
            if (!samePath(keeper.path, canonicalPath) && !(await fs.pathExists(canonicalPath))) {
                await yieldToPipeline();
                if (pipelinePromise || activeQcMutations > 0 || (generationAtStart !== undefined && pipelineGeneration !== generationAtStart)) {
                    return { archived, flagged, interrupted: true };
                }
                beginQcMutation();
                try {
                    await fs.ensureDir(path.dirname(canonicalPath));
                    await fs.move(keeper.path, canonicalPath, { overwrite: false });
                    qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(path.resolve(keeper.path));
                    db.prepare('DELETE FROM processed_files WHERE path=?').run(path.resolve(keeper.path));
                    log(`[QC DUPLICATE NORMALIZED] Renamed the kept highest-numbered copy to ${path.basename(canonicalPath)}.`);
                } catch (error) {
                    log(`[QC DUPLICATE RENAME] Could not normalize ${path.basename(keeper.path)}: ${error.message}`, 'WARN');
                } finally {
                    endQcMutation();
                }
            }
        }
    }
    if (archived || flagged) log(`QC duplicate pass: ${archived} duplicate copy/copies moved to Recovery; ${flagged} chapter group(s) with different contents need review.`);
    return { archived, flagged, interrupted: false };
}

async function scanLibraryHealth({ runId, onProgress = null, useCache = true, autoFix = false, batchSize = 20, batchDelayMs = 15 } = {}) {
    const { destRoot } = getRoots();
    if (!destRoot || !(await fs.pathExists(destRoot))) throw new Error(`Library folder is unavailable: "${destRoot}"`);
    if (!runId) throw new Error('A QC scan run ID is required.');

    let done = Number(qcDb.prepare('SELECT done FROM qc_scan_runs WHERE id=?').get(runId)?.done || 0);
    let issueCount = Number(qcDb.prepare('SELECT issue_count FROM qc_scan_runs WHERE id=?').get(runId)?.issue_count || 0);
    let cacheHits = Number(qcDb.prepare('SELECT cache_hits FROM qc_scan_runs WHERE id=?').get(runId)?.cache_hits || 0);
    let repaired = Number(qcDb.prepare('SELECT repaired FROM qc_scan_runs WHERE id=?').get(runId)?.repaired || 0);
    const batchLimit = Math.max(5, Math.min(100, Number(batchSize) || 20));
    const pauseMs = Math.max(0, Math.min(250, Number(batchDelayMs) || 0));
    let pendingFixes = [];
    const automaticFixesEnabled = () => autoFix || Boolean(qcDb.prepare('SELECT auto_fix FROM qc_scan_runs WHERE id=?').get(runId)?.auto_fix);

    const upsertCache = qcDb.prepare(`INSERT INTO qc_cache (path, size, mtime, issues, reason, has_issues, scanned_at, parser_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, issues=excluded.issues,
            reason=excluded.reason, has_issues=excluded.has_issues, scanned_at=excluded.scanned_at, parser_version=excluded.parser_version`);
    const getCache = qcDb.prepare('SELECT size, mtime, issues, reason, has_issues, parser_version FROM qc_cache WHERE path=?');
    const addDirectory = qcDb.prepare("INSERT OR IGNORE INTO qc_scan_dirs (run_id, path, status) VALUES (?, ?, 'pending')");
    const pickDirectory = qcDb.prepare("SELECT id, path FROM qc_scan_dirs WHERE run_id=? AND status IN ('pending','scanning') ORDER BY id LIMIT 1");
    const updateProgress = qcDb.prepare(`UPDATE qc_scan_runs SET done=?, issue_count=?, cache_hits=?, repaired=?, updated_at=? WHERE id=?`);

    const flushFixes = async () => {
        if (!pendingFixes.length) return;
        const batch = pendingFixes;
        pendingFixes = [];
        const result = await fixLibraryIssues(batch);
        repaired += result.fixed || 0;
    };

    onProgress?.({ done, total: null, issueCount, cacheHits, repaired });
    while (true) {
        await yieldToPipeline();
        const dirRow = pickDirectory.get(runId);
        if (!dirRow) break;
        qcDb.prepare("UPDATE qc_scan_dirs SET status='scanning' WHERE id=?").run(dirRow.id);
        let processedInDirectory = 0;
        let pausedForPipeline = false;
        let directoryReadComplete = false;
        let directoryReadError = null;
        const pipelineGenerationAtStart = pipelineGeneration;
        try {

            const directory = await require('fs').promises.opendir(dirRow.path);
            for await (const entry of directory) {

                if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== pipelineGenerationAtStart) { pausedForPipeline = true; break; }
                const lowerName = entry.name.toLowerCase();
                if (entry.isDirectory()) {
                    if (['node_modules', '.git', '$recycle.bin', '.panelkeeper-recovery', '.panelkeeper-trash'].includes(lowerName) || lowerName.startsWith('.panelkeeper-')) continue;
                    addDirectory.run(runId, path.join(dirRow.path, entry.name));
                    continue;
                }
                if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.cbz') continue;

                const filePath = path.join(dirRow.path, entry.name);
                done++;
                processedInDirectory++;
                const stats = await fs.stat(filePath).catch(() => null);
                if (!stats) continue;
                const file = path.basename(filePath);
                const series = seriesNameFromPath(filePath, destRoot);
                const resolvedPath = path.resolve(filePath);
                const cache = useCache ? getCache.get(resolvedPath) : null;
                let fileIssues = null;
                let reason = '';
                let cacheValid = false;
                let cacheNeedsUpdate = false;

                if (cache && Number(cache.parser_version || 1) === QC_ANALYSIS_VERSION && cache.size === stats.size && cache.mtime === Math.floor(stats.mtimeMs)) {
                    try {
                        fileIssues = JSON.parse(cache.issues);
                        const withoutStaleDuplicateFlag = fileIssues.filter(issue => issue !== 'duplicate_chapter');
                        cacheNeedsUpdate = withoutStaleDuplicateFlag.length !== fileIssues.length;
                        fileIssues = withoutStaleDuplicateFlag;
                        reason = cache.reason || '';
                        cacheHits++;
                        cacheValid = true;
                    } catch (_) { fileIssues = null; }
                }
                if (!fileIssues) {
                    fileIssues = [];
                    const parsedChapter = parseQcChapterPath(filePath, series);
                    if (!hasCorrectName(filePath, series)) fileIssues.push('bad_name');
                    const ignoredTerms = getEffectiveIgnoredTerms(series);
                    let chapterFilenameStem = path.basename(filePath).replace(/\.(?:cbz|zip)$/i, '');
                    if (series) chapterFilenameStem = chapterFilenameStem.replace(new RegExp(String(series).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
                    if (ignoredTerms.length && hasIgnoredChapterTerms(chapterFilenameStem, ignoredTerms)) {
                        if (!fileIssues.includes('bad_name')) fileIssues.push('bad_name');
                        reason = reason ? `${reason} Configured ignored chapter text is present and can be normalized: ${ignoredTerms.join(', ')}.`
                            : `Configured ignored chapter text is present and can be normalized: ${ignoredTerms.join(', ')}.`;
                    }
                    if (!parsedChapter) {
                        if (!fileIssues.includes('bad_name')) fileIssues.push('bad_name');
                        fileIssues.push('unparsed_chapter');
                        reason = `No safe chapter name could be derived from this filename: ${file}. Send it to Files Needing Attention to assign a chapter label or remove it if it is not a chapter.`;
                    } else if (parsedChapter.special) {
                        const specialDestination = buildChapterDestination(path.resolve(destRoot, series), series, parsedChapter, { persistSpecial: true });
                        if (!samePath(filePath, specialDestination.path)) {
                            fileIssues.push('special_needs_kavita_path');
                            reason = `Special recognized as ${specialDestination.fileName}. Kavita Specials belong in the Specials subfolder and use an SP## filename.`;
                        }
                    }
                    try {
                        const archive = await zip.readZipDirectory(filePath);
                        if (archive.entries.some(item => zip.isComicInfo(item.name))) fileIssues.push('has_xml');
                    } catch (error) {
                        fileIssues.push(archiveIssueKind(error) === 'unsupported_archive' ? 'unsupported_archive' : 'bad_archive');
                        reason = reason ? `${reason} Archive check: ${error.message}` : error.message;
                    }
                }

                const queueFilteredIssues = filterQcIssuesHandledByReviewQueues(resolvedPath, fileIssues);
                if (queueFilteredIssues.length !== fileIssues.length) cacheNeedsUpdate = true;
                fileIssues = queueFilteredIssues;

                if (getComicInfoPolicy(series) === 'leave') {
                    fileIssues = fileIssues.filter(issue => issue !== 'has_xml');
                    cacheNeedsUpdate = true;
                }

                if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== pipelineGenerationAtStart) {
                    pausedForPipeline = true;
                    break;
                }
                if (fileIssues.length) issueCount++;
                if (!cacheValid || cacheNeedsUpdate) {
                    upsertCache.run(resolvedPath, stats.size, Math.floor(stats.mtimeMs), JSON.stringify(fileIssues), reason, fileIssues.length ? 1 : 0, new Date().toISOString(), QC_ANALYSIS_VERSION);
                } else if (Number(cache.has_issues) !== (fileIssues.length ? 1 : 0)) {
                    qcDb.prepare('UPDATE qc_cache SET has_issues=? WHERE path=?').run(fileIssues.length ? 1 : 0, resolvedPath);
                }

                if (automaticFixesEnabled() && fileIssues.some(issue => issue === 'bad_name' || issue === 'unparsed_chapter' || issue === 'special_needs_kavita_path' || issue === 'bad_archive' || issue === 'unsupported_archive' || (issue === 'has_xml' && getComicInfoPolicy(series) !== 'leave'))) {
                    pendingFixes.push({ series, file, path: filePath, issues: fileIssues, reason });
                }

                if (processedInDirectory % batchLimit === 0) {
                    if (pipelinePromise || activeQcMutations > 0 || pipelineGeneration !== pipelineGenerationAtStart) { pausedForPipeline = true; break; }
                    await flushFixes();
                    updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
                    onProgress?.({ done, total: null, issueCount, cacheHits, repaired, current: file });

                    await new Promise(resolve => setTimeout(resolve, pauseMs));
                }
            }
            directoryReadComplete = !pausedForPipeline;
        } catch (error) {
            directoryReadError = error;
            log(`QC cannot scan directory "${dirRow.path}": ${error.message}`, 'WARN');
        }
        if (pipelinePromise || pipelineGeneration !== pipelineGenerationAtStart) pausedForPipeline = true;

        if (!pausedForPipeline && directoryReadComplete) {
            await flushFixes();
            if (pipelinePromise || pipelineGeneration !== pipelineGenerationAtStart) pausedForPipeline = true;
        }
        if (!pausedForPipeline && directoryReadComplete) {
            try {
                const duplicateScan = await collectDirectoryDuplicateGroups(dirRow.path, destRoot, pipelineGenerationAtStart);
                if (duplicateScan.interrupted) {
                    pausedForPipeline = true;
                } else {
                    const duplicateResult = await processDirectoryDuplicateGroups(duplicateScan.groups, { generationAtStart: pipelineGenerationAtStart });
                    if (duplicateResult.interrupted) pausedForPipeline = true;
                }
            } catch (error) {
                log(`QC duplicate check could not finish for "${dirRow.path}": ${error.message}`, 'WARN');
                directoryReadError = error;
            }
            if (pipelinePromise || pipelineGeneration !== pipelineGenerationAtStart) pausedForPipeline = true;
        }
        if (pausedForPipeline) {
            qcDb.prepare("UPDATE qc_scan_dirs SET status='pending' WHERE id=?").run(dirRow.id);
            updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
            await flushFixes();
            await yieldToPipeline();
            continue;
        }
        if (!directoryReadComplete || directoryReadError) {
            if (directoryReadError) {

                qcDb.prepare("UPDATE qc_scan_dirs SET status='error' WHERE id=?").run(dirRow.id);
                updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
                continue;
            }
            qcDb.prepare("UPDATE qc_scan_dirs SET status='pending' WHERE id=?").run(dirRow.id);
            updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }
        await flushFixes();
        if (pipelinePromise || pipelineGeneration !== pipelineGenerationAtStart) {
            qcDb.prepare("UPDATE qc_scan_dirs SET status='pending' WHERE id=?").run(dirRow.id);
            updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
            await yieldToPipeline();
            continue;
        }
        qcDb.prepare("UPDATE qc_scan_dirs SET status='done' WHERE id=?").run(dirRow.id);
        updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
        onProgress?.({ done, total: null, issueCount, cacheHits, repaired, current: path.basename(dirRow.path) });
    }

    const finalIssueCount = qcDb.prepare(`SELECT COUNT(*) AS count FROM qc_cache
        WHERE has_issues=1 AND NOT EXISTS (SELECT 1 FROM qc_dismissed d
            WHERE d.path=qc_cache.path AND d.size=qc_cache.size AND d.mtime=qc_cache.mtime)`).get().count;
    issueCount = finalIssueCount;
    updateProgress.run(done, issueCount, cacheHits, repaired, new Date().toISOString(), runId);
    log(`QC scan complete: ${done} CBZ file(s) visited, ${issueCount} current cached issue(s), ${cacheHits} cached metadata result(s), ${repaired} repair action(s).`);
    if (issueCount || repaired) sendNotification(`PanelKeeper Quality Control finished: ${issueCount} issue(s) remain and ${repaired} repair action(s) completed.`, { event: 'qc' }).catch(() => {});
    return { done, total: done, issueCount, cacheHits, repaired };
}

function startQcScan({ reason = 'manual QC scan', autoFix = false, useCache = true, resumeId = null } = {}) {
    if (activeQcJob && activeQcJob.status === 'running') {
        if (autoFix && !activeQcJob.autoFix) {

            qcDb.prepare('UPDATE qc_scan_runs SET auto_fix=1, reason=? WHERE id=?').run(reason, activeQcJob.id);
            activeQcJob.autoFix = true;
            activeQcJob.reason = reason;
        }
        return { ...activeQcJob, progress: { ...activeQcJob.progress }, alreadyRunning: true };
    }
    const { destRoot } = getRoots();
    if (!destRoot) throw new Error('Set the Manga Library destination before starting QC.');
    const root = path.resolve(destRoot);
    let run = resumeId ? qcDb.prepare("SELECT * FROM qc_scan_runs WHERE id=? AND status='running'").get(resumeId) : null;
    if (!run) run = qcDb.prepare("SELECT * FROM qc_scan_runs WHERE root=? AND status='running' ORDER BY started_at DESC LIMIT 1").get(root);

    if (run) {

        qcDb.prepare("UPDATE qc_scan_dirs SET status='pending' WHERE run_id=? AND status='scanning'").run(run.id);
        reason = run.reason || reason;
        autoFix = Boolean(run.auto_fix);
    } else {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        qcDb.prepare(`INSERT INTO qc_scan_runs (id, root, reason, status, auto_fix, started_at, updated_at)
            VALUES (?, ?, ?, 'running', ?, ?, ?)`)
            .run(id, root, reason, autoFix ? 1 : 0, now, now);
        qcDb.prepare("INSERT INTO qc_scan_dirs (run_id, path, status) VALUES (?, ?, 'pending')").run(id, root);
        run = qcDb.prepare('SELECT * FROM qc_scan_runs WHERE id=?').get(id);
    }

    const job = {
        id: run.id,
        reason: run.reason,
        autoFix: Boolean(run.auto_fix),
        status: 'running',
        progress: { done: run.done, total: null, issueCount: run.issue_count, cacheHits: run.cache_hits, repaired: run.repaired },
        error: null,
        startedAt: run.started_at,
        finishedAt: null
    };
    activeQcJob = job;
    log(`${run.status === 'running' && run.done ? 'Resuming' : 'Starting'} background QC scan (${reason}${autoFix ? '; automatic safe repairs enabled' : ''}).`);
    setImmediate(async () => {
        try {
            job.progress = await scanLibraryHealth({
                runId: job.id,
                useCache,
                autoFix,
                batchSize: 20,
                batchDelayMs: 15,
                onProgress: progress => { job.progress = progress; }
            });
            job.status = 'completed';
            qcDb.prepare("UPDATE qc_scan_runs SET status='completed', finished_at=?, updated_at=?, error=NULL WHERE id=?")
                .run(new Date().toISOString(), new Date().toISOString(), job.id);
            qcDb.prepare("DELETE FROM qc_scan_dirs WHERE run_id=? AND status <> 'error'").run(job.id);
            if (job.reason === 'scheduled automatic QC') {
                db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
                    .run('lastAutoQC', new Date().toISOString());
            }
        } catch (error) {
            job.status = 'failed';
            job.error = error.message;
            qcDb.prepare("UPDATE qc_scan_runs SET status='failed', error=?, updated_at=?, finished_at=? WHERE id=?")
                .run(error.message, new Date().toISOString(), new Date().toISOString(), job.id);
            log(`Background QC scan failed: ${error.stack || error.message}`, 'ERROR');
        } finally {
            job.finishedAt = new Date().toISOString();
            if (activeQcJob?.id === job.id) activeQcJob = null;
            qcDb.prepare("DELETE FROM qc_scan_runs WHERE id NOT IN (SELECT id FROM qc_scan_runs ORDER BY started_at DESC LIMIT 10) AND status <> 'running'").run();
        }
    });
    return { ...job, progress: { ...job.progress } };
}

function resumeInterruptedQcScan() {
    const { destRoot } = getRoots();
    if (!destRoot) return null;
    const root = path.resolve(destRoot);
    const run = qcDb.prepare("SELECT id FROM qc_scan_runs WHERE root=? AND status='running' ORDER BY started_at DESC LIMIT 1").get(root);
    return run ? startQcScan({ resumeId: run.id }) : null;
}

function getQcScanStatus(id) {
    const row = qcDb.prepare('SELECT * FROM qc_scan_runs WHERE id=?').get(String(id));
    if (!row) return null;
    const currentDirectory = row.status === 'running'
        ? qcDb.prepare("SELECT path FROM qc_scan_dirs WHERE run_id=? AND status='scanning' ORDER BY id LIMIT 1").get(row.id)?.path || null
        : null;
    const directoryErrors = Number(qcDb.prepare("SELECT COUNT(*) AS count FROM qc_scan_dirs WHERE run_id=? AND status='error'").get(row.id)?.count || 0);
    return {
        id: row.id,
        reason: row.reason,
        status: row.status,
        progress: { done: row.done, total: row.status === 'completed' ? row.done : null, issueCount: row.issue_count, cacheHits: row.cache_hits, repaired: row.repaired },
        currentDirectory,
        directoryErrors,
        updatedAt: row.updated_at,
        error: row.error,
        startedAt: row.started_at,
        finishedAt: row.finished_at
    };
}

let pendingQcAttentionLookup = null;
let pendingQcConflictLookup = null;
function filterQcIssuesHandledByReviewQueues(filePath, issueList) {
    if (!Array.isArray(issueList) || issueList.length === 0) return issueList || [];
    const resolved = path.resolve(filePath);
    pendingQcAttentionLookup ||= db.prepare("SELECT kind FROM file_issues WHERE path=? AND status='pending'");
    pendingQcConflictLookup ||= db.prepare(`SELECT 1 AS pending FROM pending_conflicts
        WHERE status='pending' AND (source_path=? OR destination_path=?) LIMIT 1`);
    const attention = pendingQcAttentionLookup.get(resolved);
    const pendingConflict = pendingQcConflictLookup.get(resolved, resolved);
    const filtered = new Set(issueList);
    if (attention) {
        const handled = {
            unparsed_chapter: ['bad_name', 'unparsed_chapter', 'special_needs_kavita_path'],
            manual_chapter: ['bad_name', 'unparsed_chapter', 'special_needs_kavita_path'],
            bad_archive: ['bad_archive'],
            unsupported_archive: ['unsupported_archive'],
            xml_cleanup_failed: ['has_xml', 'xml_cleanup_failed'],
            move_failed: ['move_failed']
        }[String(attention.kind)] || [];
        for (const issue of handled) filtered.delete(issue);
    }
    if (pendingConflict) {
        for (const issue of ['bad_name', 'unparsed_chapter', 'special_needs_kavita_path', 'duplicate_chapter']) filtered.delete(issue);
    }
    return [...filtered];
}

function getQcIssueSummary() {
    const activeFilter = `has_issues=1 AND NOT EXISTS (SELECT 1 FROM qc_dismissed d
        WHERE d.path=qc_cache.path AND d.size=qc_cache.size AND d.mtime=qc_cache.mtime)`;
    const cachedPaths = issue => qcDb.prepare(`SELECT path FROM qc_cache WHERE ${activeFilter} AND issues LIKE ?`)
        .all(`%\"${issue}\"%`).map(row => path.resolve(row.path));
    const countCached = issue => cachedPaths(issue).length;
    const total = Number(qcDb.prepare(`SELECT COUNT(*) AS count FROM qc_cache WHERE ${activeFilter}`).get()?.count || 0);
    const naming = countCached('bad_name') + countCached('unparsed_chapter');
    const specials = countCached('special_needs_kavita_path');
    const comicInfo = countCached('has_xml');
    const countAcrossQcAndAttention = (issues, attentionKinds) => {
        const paths = new Set(issues.flatMap(cachedPaths));
        if (attentionKinds.length) {
            const placeholders = attentionKinds.map(() => '?').join(',');
            for (const row of db.prepare(`SELECT path FROM file_issues WHERE status='pending' AND kind IN (${placeholders})`).all(...attentionKinds)) {
                paths.add(path.resolve(row.path));
            }
        }
        return paths.size;
    };
    const invalidCbz = countAcrossQcAndAttention(['bad_archive', 'unsupported_archive'], ['bad_archive', 'unsupported_archive']);
    const policyFailures = countAcrossQcAndAttention(['xml_cleanup_failed'], ['xml_cleanup_failed']);
    const duplicates = countCached('duplicate_chapter');

    return { total, naming, specials, comicInfo, archives: invalidCbz, invalidCbz, policyFailures, duplicates };
}

function getLatestQcScanStatus() {
    const row = qcDb.prepare('SELECT id FROM qc_scan_runs ORDER BY started_at DESC LIMIT 1').get();
    const summary = getQcIssueSummary();
    if (!row) return { status: 'not_run', progress: { done: 0, total: null, issueCount: summary.total, cacheHits: 0, repaired: 0 }, summary };
    return { ...getQcScanStatus(row.id), summary };
}

function getSeriesPendingCounts() {
    const counts = new Map();
    for (const row of db.prepare("SELECT target_series AS series, COUNT(*) AS count FROM pending_conflicts WHERE status='pending' GROUP BY target_series").all()) {
        counts.set(row.series, (counts.get(row.series) || 0) + Number(row.count || 0));
    }
    for (const row of db.prepare("SELECT series, COUNT(*) AS count FROM recovery_items WHERE status='available' GROUP BY series").all()) {
        counts.set(row.series, (counts.get(row.series) || 0) + Number(row.count || 0));
    }

    const { destRoot } = getRoots();
    if (destRoot) {
        const qcCounts = qcDb.prepare(`SELECT pk_path_series(path, ?) AS series, COUNT(*) AS count
            FROM qc_cache WHERE has_issues=1
              AND NOT EXISTS (SELECT 1 FROM qc_dismissed d WHERE d.path=qc_cache.path AND d.size=qc_cache.size AND d.mtime=qc_cache.mtime)
            GROUP BY series HAVING series <> ''`).all(destRoot);
        for (const row of qcCounts) counts.set(row.series, (counts.get(row.series) || 0) + Number(row.count || 0));

        const issueRows = db.prepare("SELECT path, target_series FROM file_issues WHERE status='pending'").all();
        const qcPathExists = qcDb.prepare(`SELECT 1 FROM qc_cache WHERE lower(path)=lower(?) AND has_issues=1
            AND NOT EXISTS (SELECT 1 FROM qc_dismissed d WHERE d.path=qc_cache.path AND d.size=qc_cache.size AND d.mtime=qc_cache.mtime) LIMIT 1`);
        for (const row of issueRows) {
            if (qcPathExists.get(row.path)) continue;
            const series = row.target_series || inferSeriesForFilePath(row.path) || '';
            if (series) counts.set(series, (counts.get(series) || 0) + 1);
        }
    }
    return Object.fromEntries([...counts.entries()]);
}

function getIssueSeriesFilters() {
    const rows = db.prepare("SELECT id, path, target_series FROM file_issues WHERE status='pending'").all();
    const counts = new Map();
    const update = db.prepare('UPDATE file_issues SET target_series=? WHERE id=? AND target_series=\'\'');
    for (const row of rows) {
        let series = row.target_series || inferSeriesForFilePath(row.path) || '';
        if (!row.target_series && series) update.run(series, row.id);
        const key = series || '';
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }))
        .map(([name, count]) => ({ name, count }));
}

function getQcSeriesFilters() {
    const { destRoot } = getRoots();
    if (!destRoot) return [];

    return qcDb.prepare(`SELECT pk_path_series(path, ?) AS name, COUNT(*) AS count
        FROM qc_cache WHERE has_issues=1
          AND NOT EXISTS (SELECT 1 FROM qc_dismissed d WHERE d.path=qc_cache.path AND d.size=qc_cache.size AND d.mtime=qc_cache.mtime)
        GROUP BY name HAVING name <> '' ORDER BY pk_natural_key(name)`).all(destRoot);
}

function buildSeriesProposal(targetSeries, chapter, targetDirectory, currentPath = '') {
    if (!targetSeries || !chapter || !targetDirectory) return null;
    const destination = buildChapterDestination(targetDirectory, targetSeries, { ...chapter }, { persistSpecial: false });
    const proposedName = destination.fileName;
    const proposedPath = destination.path;
    return {
        proposedName, proposedPath,
        proposedExists: currentPath && samePath(currentPath, proposedPath) ? false : getPathPresence(proposedPath),
        proposedIsCurrent: Boolean(currentPath && samePath(currentPath, proposedPath)),
        targetSeries, chapterLabel: chapter.label, chapterKey: chapter.key
    };
}

function getQueuedChapterForPath(fullPath, targetSeries = '') {
    const resolved = path.resolve(fullPath);
    const override = db.prepare('SELECT chapter_label, chapter_key FROM chapter_overrides WHERE path=?').get(resolved);
    const filename = portableBasename(resolved);
    const parsedFromFilename = parseSeriesChapter(filename, targetSeries);
    if (override) {
        const parsedOverride = parseSeriesChapterLabel(override.chapter_label, targetSeries);
        if (parsedOverride) return resolveChapterOverride(parsedFromFilename, parsedOverride, override, targetSeries);
    }
    return parsedFromFilename;
}

function getIssueProposal(issue, chapterInput = '') {
    if (!issue?.path) return {
        targetSeries: '', chapterLabel: '', autoParsedChapter: false,
        proposedName: null, proposedPath: null, proposedExists: null, proposedIsCurrent: false,
        proposalMessage: 'No file path is available.'
    };
    const fullPath = path.resolve(issue.path);
    const { sourceRoot, destRoot } = getRoots();
    let targetSeries = '';
    let targetDirectory = '';
    if (destRoot && isWithin(destRoot, fullPath) && !samePath(destRoot, fullPath)) {
        targetSeries = seriesNameFromPath(fullPath, destRoot);
        targetDirectory = path.resolve(destRoot, targetSeries);
    } else if (sourceRoot && destRoot && isWithin(sourceRoot, fullPath) && !samePath(sourceRoot, fullPath)) {
        const mapping = findMappedTargetForSourceFile(fullPath);
        if (mapping) {
            targetSeries = mapping.target_series;
            targetDirectory = path.join(destRoot, targetSeries);
        }
    }

    const parsedFromFilename = getQueuedChapterForPath(fullPath, targetSeries);
    const parsedFromInput = String(chapterInput || '').trim() ? parseSeriesChapterLabel(chapterInput, targetSeries) : null;
    const parsed = (parsedFromInput && resolveChapterOverride(parsedFromFilename, parsedFromInput, {
        chapter_label: parsedFromInput.label, chapter_key: parsedFromInput.key
    }, targetSeries)) || parsedFromInput || parsedFromFilename;
    const base = {
        targetSeries,
        chapterLabel: parsed?.label || '',
        chapterKey: parsed?.key || '',
        autoParsedChapter: Boolean(parsedFromFilename),
        proposedName: null,
        proposedPath: null,
        proposedExists: null,
        proposedIsCurrent: false
    };

    if (!targetSeries || !targetDirectory) {
        return {
            ...base,
            proposalMessage: parsed
                ? `Recognized as ${parsed.label}, but no active series mapping identifies the destination. Map this source folder in Series Mapper first.`
                : 'No active series mapping identifies the destination. Map this source folder in Series Mapper first.'
        };
    }
    if (!parsed) {
        return {
            ...base,
            proposalMessage: 'A corrected chapter label is needed before a destination filename can be proposed.'
        };
    }
    return {
        ...base,
        ...(buildSeriesProposal(targetSeries, parsed, targetDirectory, fullPath) || {}),
        proposalMessage: ''
    };
}

function getConflictProposal(conflict) {
    const { destRoot } = getRoots();
    if (!destRoot || !conflict?.target_series) {
        return { proposedName: null, proposedPath: null, proposedExists: null, proposedIsCurrent: false };
    }
    const targetDirectory = path.resolve(destRoot, conflict.target_series);
    if (!isWithin(destRoot, targetDirectory) || samePath(destRoot, targetDirectory)) {
        return { proposedName: null, proposedPath: null, proposedExists: null, proposedIsCurrent: false };
    }
    const currentChapter = conflict.source_path
        ? getQueuedChapterForPath(conflict.source_path, conflict.target_series)
        : null;
    const chapter = currentChapter || (conflict.chapter_label ? {
        label: conflict.chapter_label,
        key: conflict.chapter_key || ''
    } : null);
    if (!chapter) return { proposedName: null, proposedPath: null, proposedExists: null, proposedIsCurrent: false };
    const proposal = buildSeriesProposal(conflict.target_series, chapter, targetDirectory, conflict.source_path);
    if (!proposal) return { proposedName: null, proposedPath: null, proposedExists: null, proposedIsCurrent: false };
    return {
        ...proposal,
        chapterLabel: chapter.label,
        chapter_label: chapter.label,
        chapterKey: chapter.key,
        chapter_key: chapter.key,
        parserProposalUpdated: Boolean(currentChapter && currentChapter.label !== conflict.chapter_label)
    };
}

async function reconcileQueuedChapterItems() {
    if (queuedChapterReconcileComplete) return queuedChapterReconcileResult || { complete: true, skipped: true };
    if (queuedChapterReconcilePromise) return queuedChapterReconcilePromise;

    queuedChapterReconcilePromise = (async () => {
        const stats = {
            attentionChecked: 0, attentionRenamed: 0, attentionToConflicts: 0,
            downloadsRequeued: 0, conflictsUpdated: 0, conflictsRequeued: 0,
            conflictsRenamed: 0, deferred: 0, pipelineStarted: false
        };
        const { sourceRoot, destRoot } = getRoots();
        if (!sourceRoot || !destRoot) {
            stats.deferred++;
            return stats;
        }
        const sourceRootPresent = getPathPresence(sourceRoot) === true;
        const destRootPresent = getPathPresence(destRoot) === true;
        if (!sourceRootPresent && !destRootPresent) {
            stats.deferred++;
            return stats;
        }

        await yieldToPipeline();
        const now = () => new Date().toISOString();
        const updateIssue = db.prepare("UPDATE file_issues SET status=?, reason=?, updated_at=? WHERE id=? AND status='pending'");
        const upsertOverride = db.prepare(`INSERT INTO chapter_overrides (path, chapter_label, chapter_key, created_at)
            VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET chapter_label=excluded.chapter_label,
            chapter_key=excluded.chapter_key, created_at=excluded.created_at`);

        const directoryChapterIndexes = new Map();
        async function getDirectoryChapterIndex(directory, series) {
            const key = pathKey(directory);
            if (directoryChapterIndexes.has(key)) return directoryChapterIndexes.get(key);
            const index = new Map();
            let entries = [];
            try { entries = await fs.readdir(directory, { withFileTypes: true }); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            for (const entry of entries) {
                if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.cbz') continue;
                const parsed = parseSeriesChapter(entry.name, series);
                if (!parsed) continue;
                const filePath = path.join(directory, entry.name);
                if (!index.has(parsed.key)) index.set(parsed.key, []);
                index.get(parsed.key).push(filePath);
            }
            directoryChapterIndexes.set(key, index);
            return index;
        }
        async function findIndexedCollision(directory, series, chapter, sourcePath) {
            const index = await getDirectoryChapterIndex(directory, series);
            return (index.get(chapter.key) || []).find(candidate => !samePath(candidate, sourcePath)) || null;
        }
        async function trackIndexedRename(directory, series, chapter, oldPath, newPath) {
            const index = await getDirectoryChapterIndex(directory, series);
            for (const [key, paths] of index.entries()) {
                const remaining = paths.filter(candidate => !samePath(candidate, oldPath));
                if (remaining.length) index.set(key, remaining);
                else index.delete(key);
            }
            if (!index.has(chapter.key)) index.set(chapter.key, []);
            index.get(chapter.key).push(path.resolve(newPath));
        }

        const attentionRows = db.prepare("SELECT * FROM file_issues WHERE status='pending' AND kind='unparsed_chapter' ORDER BY id").all();
        for (const issue of attentionRows) {
            stats.attentionChecked++;
            const fullPath = path.resolve(issue.path);
            const presence = getPathPresence(fullPath);
            if (presence === null) { stats.deferred++; continue; }
            if (presence === false) {
                updateIssue.run('missing', 'The file is no longer present at this path. No file was deleted by PanelKeeper.', now(), issue.id);
                continue;
            }

            const inLibrary = isWithin(destRoot, fullPath) && !samePath(destRoot, fullPath);
            const inDownloads = isWithin(sourceRoot, fullPath) && !samePath(sourceRoot, fullPath);
            if (!inLibrary && !inDownloads) { stats.deferred++; continue; }
            const mapping = inDownloads ? findMappedTargetForSourceFile(fullPath) : null;
            const targetSeries = inLibrary ? seriesNameFromPath(fullPath, destRoot) : mapping?.target_series || '';
            const chapter = getQueuedChapterForPath(fullPath, targetSeries);
            if (!chapter) continue;

            if (inDownloads) {
                if (!mapping) {
                    db.prepare('UPDATE file_issues SET reason=?, updated_at=? WHERE id=? AND status=\'pending\'')
                        .run(`The updated parser recognizes ${chapter.label}, but this download path has no active series mapping yet. Map its source folder to resume automatic processing.`, now(), issue.id);
                    continue;
                }
                upsertOverride.run(fullPath, chapter.label, chapter.key, now());
                db.prepare('UPDATE file_issues SET reason=?, updated_at=? WHERE id=? AND status=\'pending\'')
                    .run(`Updated chapter parser recognized ${chapter.label}. The file has been queued for the normal automatic pipeline.`, now(), issue.id);
                stats.downloadsRequeued++;
                continue;
            }

            if (!targetSeries) continue;
            const targetDirectory = path.dirname(fullPath);
            const proposedPath = path.join(targetDirectory, `${targetSeries} - ${chapter.label}.cbz`);
            await yieldToPipeline();
            beginQcMutation();
            try {
                const collision = await findIndexedCollision(targetDirectory, targetSeries, chapter, fullPath);
                if (collision) {
                    const conflictId = savePendingConflict(fullPath, collision, targetSeries, chapter,
                        `Re-evaluated from an older Attention item using parser version ${QC_ANALYSIS_VERSION}. The chapter is now recognized as ${chapter.label}; both files were preserved for the normal comparison workflow.`);
                    updateIssue.run('transferred', `Transferred to Chapter Conflicts #${conflictId}. Updated parser recognized ${chapter.label}; no manga files were changed.`, now(), issue.id);
                    qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(fullPath);
                    stats.attentionToConflicts++;
                    continue;
                }
                if (!samePath(fullPath, proposedPath)) {
                    await fs.move(fullPath, proposedPath, { overwrite: false });
                    await trackIndexedRename(targetDirectory, targetSeries, chapter, fullPath, proposedPath);
                    db.prepare('UPDATE chapter_overrides SET path=? WHERE path=?').run(path.resolve(proposedPath), fullPath);
                    db.prepare('UPDATE cover_insertions SET archive_path=? WHERE archive_path=?').run(path.resolve(proposedPath), fullPath);
                    db.prepare('DELETE FROM processed_files WHERE path=?').run(fullPath);
                    qcDb.prepare('DELETE FROM qc_cache WHERE path IN (?, ?)').run(fullPath, path.resolve(proposedPath));
                    updateIssue.run('fixed', `Re-evaluated and renamed to ${path.basename(proposedPath)} using the updated chapter parser.`, now(), issue.id);
                    await applyCoverRuleToFile(proposedPath, targetSeries).catch(error => log(`[COVER APPLY WARN] ${path.basename(proposedPath)}: ${error.message}`, 'WARN'));
                    stats.attentionRenamed++;
                } else {
                    clearQcIssueFlag(fullPath, 'bad_name');
                    clearQcIssueFlag(fullPath, 'unparsed_chapter');
                    updateIssue.run('fixed', `Re-evaluated successfully. The existing filename already matches ${chapter.label}.`, now(), issue.id);
                }
            } catch (error) {
                db.prepare('UPDATE file_issues SET reason=?, updated_at=? WHERE id=? AND status=\'pending\'')
                    .run(`Updated parser recognized ${chapter.label}, but automatic repair failed safely: ${error.message}`, now(), issue.id);
                stats.deferred++;
            } finally {
                endQcMutation();
            }
        }

        const conflictRows = db.prepare("SELECT * FROM pending_conflicts WHERE status='pending' ORDER BY id").all();
        for (const conflict of conflictRows) {
            const sourcePath = path.resolve(conflict.source_path);
            const presence = getPathPresence(sourcePath);
            if (presence === null) { stats.deferred++; continue; }
            if (presence === false) continue;

            const inLibrary = isWithin(destRoot, sourcePath) && !samePath(destRoot, sourcePath);
            const inDownloads = isWithin(sourceRoot, sourcePath) && !samePath(sourceRoot, sourcePath);
            if (!inLibrary && !inDownloads) { stats.deferred++; continue; }
            const mapping = inDownloads ? findMappedTargetForSourceFile(sourcePath) : null;
            const targetSeries = inLibrary ? (seriesNameFromPath(sourcePath, destRoot) || conflict.target_series) : (mapping?.target_series || conflict.target_series);
            if (!targetSeries) { stats.deferred++; continue; }
            const chapter = getQueuedChapterForPath(sourcePath, targetSeries);
            if (!chapter) continue;
            const targetDirectory = path.resolve(destRoot, targetSeries);
            if (!isWithin(destRoot, targetDirectory) || samePath(destRoot, targetDirectory)) continue;
            if (getPathPresence(destRoot) !== true) { stats.deferred++; continue; }

            await yieldToPipeline();
            beginQcMutation();
            try {
                const collision = await findIndexedCollision(targetDirectory, targetSeries, chapter, sourcePath);
                if (collision) {
                    const sourceStats = await fs.stat(sourcePath).catch(() => null);
                    const destinationStats = await fs.stat(collision).catch(() => null);
                    const changed = conflict.chapter_key !== chapter.key || conflict.chapter_label !== chapter.label || !samePath(conflict.destination_path, collision) || conflict.target_series !== targetSeries;
                    if (changed) {
                        db.prepare(`UPDATE pending_conflicts SET target_series=?, chapter_key=?, chapter_label=?, destination_path=?,
                            source_size=?, destination_size=?, decision_reason=?, updated_at=? WHERE id=? AND status='pending'`)
                            .run(targetSeries, chapter.key, chapter.label, path.resolve(collision), sourceStats?.size || 0,
                                destinationStats?.size || 0,
                                `Re-evaluated from an existing Conflict using parser version ${QC_ANALYSIS_VERSION}. Current chapter identity: ${chapter.label}. Existing and incoming files remain unchanged pending your normal decision.`,
                                now(), conflict.id);
                        stats.conflictsUpdated++;
                    }
                    clearQcIssueFlag(sourcePath, 'bad_name');
                    clearQcIssueFlag(sourcePath, 'unparsed_chapter');
                    continue;
                }

                if (inDownloads && mapping) {
                    upsertOverride.run(sourcePath, chapter.label, chapter.key, now());
                    db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='requeued_after_parser_update', updated_at=? WHERE id=? AND status='pending'")
                        .run(now(), conflict.id);
                    qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(sourcePath);
                    stats.conflictsRequeued++;
                    stats.downloadsRequeued++;
                    continue;
                }

                if (inLibrary) {
                    const proposedPath = path.join(targetDirectory, `${targetSeries} - ${chapter.label}.cbz`);
                    if (!samePath(sourcePath, proposedPath)) {
                        await fs.move(sourcePath, proposedPath, { overwrite: false });
                        await trackIndexedRename(targetDirectory, targetSeries, chapter, sourcePath, proposedPath);
                        db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='renamed_after_parser_update', updated_at=? WHERE id=? AND status='pending'")
                            .run(now(), conflict.id);
                        db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(sourcePath);
                        db.prepare('DELETE FROM processed_files WHERE path=?').run(sourcePath);
                        db.prepare('UPDATE cover_insertions SET archive_path=? WHERE archive_path=?').run(path.resolve(proposedPath), sourcePath);
                        qcDb.prepare('DELETE FROM qc_cache WHERE path IN (?, ?)').run(sourcePath, path.resolve(proposedPath));
                        resolveFileIssue(sourcePath);
                        await applyCoverRuleToFile(proposedPath, targetSeries).catch(error => log(`[COVER APPLY WARN] ${path.basename(proposedPath)}: ${error.message}`, 'WARN'));
                        stats.conflictsRenamed++;
                    } else {
                        db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='parser_revalidated', updated_at=? WHERE id=? AND status='pending'")
                            .run(now(), conflict.id);
                        resolveFileIssue(sourcePath);
                    }
                } else {

                    stats.deferred++;
                }
            } catch (error) {
                log(`[QUEUE RECHECK] Could not safely re-evaluate conflict #${conflict.id}: ${error.message}`, 'WARN');
                stats.deferred++;
            } finally {
                endQcMutation();
            }
        }

        reconcileMissingConflicts(10000);
        queuedChapterReconcileResult = stats;

        queuedChapterReconcileComplete = stats.deferred === 0;
        if (stats.downloadsRequeued && !pipelinePromise) {
            stats.pipelineStarted = true;
            runPipeline().catch(error => log(`[QUEUE RECHECK] Requeued files could not be processed: ${error.message}`, 'ERROR'));
        }
        if (Object.values(stats).some(value => typeof value === 'number' && value > 0)) {
            log(`[QUEUE RECHECK] Attention ${stats.attentionRenamed} renamed, ${stats.attentionToConflicts} moved to Conflicts, ${stats.downloadsRequeued} downloads requeued; Conflicts ${stats.conflictsUpdated} refreshed, ${stats.conflictsRequeued} requeued, ${stats.conflictsRenamed} renamed.`, 'INFO');
        }
        return stats;
    })().finally(() => { queuedChapterReconcilePromise = null; });
    return queuedChapterReconcilePromise;
}

function previewIssueProposal(issueId, chapterInput = '') {
    const issue = db.prepare("SELECT * FROM file_issues WHERE id=? AND status='pending'").get(Number(issueId));
    if (!issue) throw new Error('Pending Attention item not found.');
    return getIssueProposal(issue, chapterInput);
}

function resolveIssueArchive(issueId) {
    const issue = db.prepare("SELECT * FROM file_issues WHERE id=? AND status='pending'").get(Number(issueId));
    if (!issue) throw new Error('Pending Attention item not found.');
    const fullPath = path.resolve(issue.path);
    const { sourceRoot, destRoot } = getRoots();
    const allowed = [sourceRoot, destRoot].filter(Boolean).some(root => isWithin(root, fullPath) && !samePath(root, fullPath));
    if (!allowed || path.extname(fullPath).toLowerCase() !== '.cbz') throw new Error('This Attention archive is outside the configured CBZ locations.');
    const presence = getPathPresence(fullPath);
    if (presence !== true) throw new Error(presence === null ? 'The archive path is unavailable or cannot be verified.' : 'The archive is no longer present on disk.');
    return { issue, fullPath };
}

function resolveRecoveryArchive(recoveryId) {
    const item = db.prepare("SELECT * FROM recovery_items WHERE id=? AND status='available'").get(Number(recoveryId));
    if (!item) throw new Error('Recovery item not found or no longer available.');
    const { destRoot } = getRoots();
    const recoveryRoot = destRoot ? path.join(destRoot, '.panelkeeper-recovery') : '';
    const fullPath = path.resolve(item.backup_path);
    if (!recoveryRoot || !isWithin(recoveryRoot, fullPath) || path.extname(fullPath).toLowerCase() !== '.cbz') {
        throw new Error('Recovery archive failed the storage safety check.');
    }
    const presence = getPathPresence(fullPath);
    if (presence !== true) throw new Error(presence === null ? 'Recovery storage is unavailable or cannot be verified.' : 'The Recovery archive is missing from disk.');
    return { item, fullPath };
}

async function getArchivePageList(filePath, series = '') {
    const directory = await zip.readZipDirectory(filePath);
    const pages = zip.imageEntries(directory, { includeManaged: true }).map((entry, index) => ({
        index,
        entryIndex: entry.index,
        name: zip.displayImageName(entry.name),
        size: entry.uncompressedSize,
        managedCover: zip.isManagedFirstImage(entry.name)
    }));
    return {
        fileName: path.basename(filePath),
        filePath,
        series,
        archiveSize: directory.fileSize,
        pages,
        pageCount: pages.length,
        editablePageCount: pages.filter(page => !page.managedCover).length
    };
}

async function getIssueArchivePages(issueId) {
    const { issue, fullPath } = resolveIssueArchive(issueId);
    return getArchivePageList(fullPath, issue.target_series || inferSeriesForFilePath(fullPath) || '');
}

async function getRecoveryArchivePages(recoveryId) {
    const { item, fullPath } = resolveRecoveryArchive(recoveryId);
    return getArchivePageList(fullPath, item.series || '');
}

function resolveLibraryArchivePath(candidatePath) {
    const { destRoot } = getRoots();
    if (!destRoot) throw new Error('The manga library destination is not configured.');
    const rawPath = String(candidatePath || '').trim();
    if (!rawPath || rawPath.length > 32768) throw new Error('A valid library CBZ path is required.');
    const fullPath = path.resolve(rawPath);
    if (path.extname(fullPath).toLowerCase() !== '.cbz' || !isWithin(destRoot, fullPath) || samePath(destRoot, fullPath)) {
        throw new Error('The selected archive is outside the configured manga library.');
    }
    const presence = getPathPresence(fullPath);
    if (presence !== true) throw new Error(presence === null ? 'The library path is unavailable or cannot be verified.' : 'The selected chapter is no longer present in the library.');
    let stat;
    try {
        stat = fs.statSync(fullPath);

        const realRoot = fs.realpathSync(destRoot);
        const realFile = fs.realpathSync(fullPath);
        if (!isWithin(realRoot, realFile) || samePath(realRoot, realFile)) {
            throw new Error('The selected CBZ resolves outside the configured manga library.');
        }
    } catch (error) {
        if (String(error.message || '').includes('resolves outside')) throw error;
        throw new Error(`Could not access the selected chapter: ${error.message}`);
    }
    if (!stat.isFile()) throw new Error('The selected library path is not a regular file.');
    return fullPath;
}

async function getLibraryArchivePages(candidatePath, series = '') {
    const fullPath = resolveLibraryArchivePath(candidatePath);
    return getArchivePageList(fullPath, series || seriesNameFromPath(fullPath, getRoots().destRoot) || '');
}

async function getLibraryArchivePage(candidatePath, index) {
    const fullPath = resolveLibraryArchivePath(candidatePath);
    return getArchivePage(fullPath, index);
}

async function getArchivePage(filePath, entryIndex) {
    const directory = await zip.readZipDirectory(filePath);
    const targetIndex = Number(entryIndex);
    const page = zip.imageEntries(directory, { includeManaged: true }).find(entry => entry.index === targetIndex);
    if (!page) throw new Error('Page not found. Refresh the page list and try again.');
    return { archivePath: filePath, entry: page };
}

async function getIssueArchivePage(issueId, index) {
    const { fullPath } = resolveIssueArchive(issueId);
    return getArchivePage(fullPath, index);
}

async function getRecoveryArchivePage(recoveryId, index) {
    const { fullPath } = resolveRecoveryArchive(recoveryId);
    return getArchivePage(fullPath, index);
}

async function updateEditedArchiveStats(filePath, issue = null, recoveryItem = null, librarySeries = '') {
    const stats = await fs.stat(filePath);
    const now = new Date().toISOString();
    if (issue) {
        db.prepare('UPDATE file_issues SET size=?, mtime=?, updated_at=? WHERE id=?').run(stats.size, Math.floor(stats.mtimeMs), now, issue.id);
    }
    if (issue || librarySeries) {
        qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(path.resolve(filePath));
        db.prepare('DELETE FROM processed_files WHERE path=?').run(path.resolve(filePath));
        const { destRoot } = getRoots();
        if (destRoot && isWithin(destRoot, filePath) && !samePath(destRoot, filePath)) {
            const series = librarySeries || issue?.target_series || seriesNameFromPath(filePath, destRoot);
            await scanLibrarySeriesDirectory(series).catch(error => log(`[PAGE EDIT] Library inventory refresh failed for ${series}: ${error.message}`, 'WARN'));
        }
    }
    if (recoveryItem) db.prepare('UPDATE recovery_items SET size=? WHERE id=?').run(stats.size, recoveryItem.id);
    return stats;
}

function resolveArchiveEditorTarget(kind, id) {
    if (kind === 'issue') return resolveIssueArchive(id);
    if (kind === 'recovery') return resolveRecoveryArchive(id);
    if (kind === 'library') {
        const fullPath = resolveLibraryArchivePath(id);
        return { fullPath, librarySeries: seriesNameFromPath(fullPath, getRoots().destRoot) || '' };
    }
    throw new Error('Unsupported archive editor target.');
}

async function deleteArchivePage(kind, id, entryIndex) {
    const resolved = resolveArchiveEditorTarget(kind, id);
    const filePath = resolved.fullPath;
    await yieldToPipeline();
    beginQcMutation();
    try {
        const directory = await zip.readZipDirectory(filePath);
        const target = directory.entries.find(entry => entry.index === Number(entryIndex));
        const currentPages = zip.imageEntries(directory, { includeManaged: true });
        if (!target || !currentPages.some(entry => entry.index === target.index)) throw new Error('The selected page no longer exists. Refresh the viewer.');
        if (zip.isManagedFirstImage(target.name)) throw new Error('This is a PanelKeeper-managed chapter cover. Change it in Chapter Covers instead of deleting it here.');
        const editablePageCount = currentPages.filter(entry => !zip.isManagedFirstImage(entry.name)).length;
        if (editablePageCount <= 1) throw new Error('The last chapter page cannot be deleted. A CBZ must retain at least one chapter image.');
        const snapshot = kind === 'library' ? await createRecoverySnapshotForPath(filePath, resolved.librarySeries) : null;
        const removed = await zip.deleteEntryInPlace(filePath, target.index);
        await updateEditedArchiveStats(filePath, resolved.issue || null, resolved.item || null, resolved.librarySeries || '');
        const locationLabel = kind === 'recovery' ? 'Recovery copy' : kind === 'library' ? 'library chapter' : 'Attention file';
        log(`[PAGE EDIT] Deleted page "${zip.displayImageName(removed.name)}" from ${path.basename(filePath)} (${locationLabel})${snapshot ? `; original saved to Recovery #${snapshot.id}` : ''}.`, 'WARN');
        return { success: true, message: `Deleted page ${zip.displayImageName(removed.name)}.${snapshot ? ' The original chapter was saved in Recovery before editing.' : ''}`, pageCount: currentPages.length - 1, recoveryId: snapshot?.id || null };
    } finally { endQcMutation(); }
}

async function reorderArchivePages(kind, id, orderedEntryIndices) {
    const resolved = resolveArchiveEditorTarget(kind, id);
    const filePath = resolved.fullPath;
    await yieldToPipeline();
    beginQcMutation();
    try {
        const snapshot = kind === 'library' ? await createRecoverySnapshotForPath(filePath, resolved.librarySeries) : null;
        const result = await zip.reorderImageEntriesInPlace(filePath, orderedEntryIndices);
        if (result.changed) await updateEditedArchiveStats(filePath, resolved.issue || null, resolved.item || null, resolved.librarySeries || '');
        else if (snapshot) {

            let removedSnapshot = false;
            try { await fs.remove(snapshot.backupPath); removedSnapshot = true; } catch (_) {}
            if (removedSnapshot) db.prepare('DELETE FROM recovery_items WHERE id=?').run(snapshot.id);
        }
        const locationLabel = kind === 'recovery' ? 'Recovery copy' : kind === 'library' ? 'library chapter' : 'Attention file';
        if (result.changed) log(`[PAGE EDIT] Reordered ${result.pageCount} pages in ${path.basename(filePath)} (${locationLabel})${snapshot ? `; original saved to Recovery #${snapshot.id}` : ''}.`, 'WARN');
        return { success: true, changed: result.changed, message: result.changed ? `Saved the new order for ${result.pageCount} pages.${snapshot ? ' The original chapter was saved in Recovery before editing.' : ''}` : 'Page order was already up to date.', recoveryId: result.changed ? (snapshot?.id || null) : null };
    } finally { endQcMutation(); }
}

async function deleteIssueArchivePage(issueId, entryIndex) { return deleteArchivePage('issue', issueId, entryIndex); }
async function deleteRecoveryArchivePage(recoveryId, entryIndex) { return deleteArchivePage('recovery', recoveryId, entryIndex); }
async function deleteLibraryArchivePage(filePath, entryIndex) { return deleteArchivePage('library', filePath, entryIndex); }
async function reorderIssueArchivePages(issueId, orderedEntryIndices) { return reorderArchivePages('issue', issueId, orderedEntryIndices); }
async function reorderRecoveryArchivePages(recoveryId, orderedEntryIndices) { return reorderArchivePages('recovery', recoveryId, orderedEntryIndices); }
async function reorderLibraryArchivePages(filePath, orderedEntryIndices) { return reorderArchivePages('library', filePath, orderedEntryIndices); }

function clearStaleSpecialQcCacheFlags() {
    const { destRoot } = getRoots();
    if (!destRoot) return 0;
    const rows = qcDb.prepare("SELECT path, issues, reason FROM qc_cache WHERE has_issues=1 AND issues LIKE ?")
        .all('%"special_needs_kavita_path"%');
    const update = qcDb.prepare('UPDATE qc_cache SET issues=?, reason=?, has_issues=?, scanned_at=?, parser_version=? WHERE path=?');
    let changed = 0;
    for (const row of rows) {
        let issues = [];
        try { issues = JSON.parse(row.issues); } catch (_) { continue; }
        if (!issues.includes('special_needs_kavita_path')) continue;
        const series = seriesNameFromPath(row.path, destRoot);
        if (!series || !isWithin(destRoot, row.path)) continue;
        let parsed = null;
        let destinationPath = '';
        try {
            parsed = parseQcChapterPath(row.path, series);
            if (parsed?.special) destinationPath = buildChapterDestination(path.resolve(destRoot, series), series, parsed, { persistSpecial: false }).path;
        } catch (_) { continue; }
        const sanitized = sanitizeSpecialQcIssue({
            issues, reason: row.reason, isSpecial: Boolean(parsed?.special),
            sourcePath: row.path, destinationPath, samePath
        });
        let nextIssues = [...sanitized.issues];
        let nextReason = sanitized.reason;

        if (parsed && !parsed.special) {
            const canonicalRegularPath = path.join(path.dirname(row.path), `${series} - ${parsed.label}.cbz`);
            if (!samePath(row.path, canonicalRegularPath) && !nextIssues.includes('bad_name')) {
                nextIssues.push('bad_name');
                nextReason = `The filename was previously interpreted as a Special, but the current chapter parser identifies it as ${parsed.label}. QC can normalize the filename.`;
            }
        }
        const changedRow = sanitized.changed || JSON.stringify(nextIssues) !== JSON.stringify(issues) || nextReason !== String(row.reason || '');
        if (!changedRow) continue;
        update.run(JSON.stringify(nextIssues), nextReason, nextIssues.length ? 1 : 0,
            new Date().toISOString(), QC_ANALYSIS_VERSION, row.path);
        changed++;
    }
    return changed;
}

function dismissQcIssue(filePath) {
    const target = String(filePath || '').trim();
    if (!target) throw new Error('A QC file path is required.');
    const row = qcDb.prepare('SELECT size, mtime FROM qc_cache WHERE path=? AND has_issues=1').get(target);
    if (!row) throw new Error('This QC finding is no longer active. Refresh the results.');
    qcDb.prepare(`INSERT INTO qc_dismissed(path,size,mtime,dismissed_at) VALUES(?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,dismissed_at=excluded.dismissed_at`)
        .run(target, row.size, row.mtime, new Date().toISOString());
    return { success: true };
}

function dismissQcIssues(filePaths) {
    if (!Array.isArray(filePaths)) throw new Error('Select one or more QC findings to mark as not an issue.');
    const targets = [...new Set(filePaths.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 250);
    if (!targets.length) throw new Error('Select one or more QC findings to mark as not an issue.');
    const find = qcDb.prepare('SELECT size, mtime FROM qc_cache WHERE path=? AND has_issues=1');
    const save = qcDb.prepare(`INSERT INTO qc_dismissed(path,size,mtime,dismissed_at) VALUES(?,?,?,?)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,dismissed_at=excluded.dismissed_at`);
    const now = new Date().toISOString();
    let dismissed = 0;
    let skipped = 0;
    const run = qcDb.transaction(() => {
        for (const target of targets) {
            const row = find.get(target);
            if (!row) { skipped++; continue; }
            save.run(target, row.size, row.mtime, now);
            dismissed++;
        }
    });
    run();
    return { success: true, requested: targets.length, dismissed, skipped };
}

function getQcResults({ page = 0, limit = 50, search = '', series = '', issue = '' } = {}) {
    clearStaleSpecialQcCacheFlags();
    const requestedPage = Math.max(0, Math.min(100000, Number.parseInt(page, 10) || 0));
    const safeLimit = Math.max(10, Math.min(250, Number.parseInt(limit, 10) || 50));
    const term = String(search ?? '').slice(0, 200);
    const selectedSeries = String(series || '').trim().slice(0, 200);
    const selectedIssue = String(issue || '').trim();
    const allowedIssues = new Set(['bad_name', 'unparsed_chapter', 'has_xml', 'bad_archive', 'unsupported_archive', 'duplicate_chapter', 'special_needs_kavita_path', 'xml_cleanup_failed', 'move_failed']);
    const { destRoot } = getRoots();
    const conditions = ['has_issues=1', `NOT EXISTS (SELECT 1 FROM qc_dismissed d WHERE d.path=qc_cache.path AND d.size=qc_cache.size AND d.mtime=qc_cache.mtime)`];
    const params = [];
    if (selectedSeries && destRoot) {
        const prefix = path.join(destRoot, selectedSeries, '');

        conditions.push('substr(path, 1, length(?)) = ? COLLATE NOCASE');
        params.push(prefix, prefix);
    }
    if (allowedIssues.has(selectedIssue)) {
        conditions.push('issues LIKE ?');
        params.push(`%\"${selectedIssue}\"%`);
    }
    if (term.length) {
        conditions.push('(pk_pattern_match(path, ?) = 1 OR pk_pattern_match(issues, ?) = 1 OR pk_pattern_match(reason, ?) = 1)');
        params.push(term, term, term);
    }
    const where = conditions.join(' AND ');
    const total = Number(qcDb.prepare(`SELECT COUNT(*) AS count FROM qc_cache WHERE ${where}`).get(...params)?.count || 0);
    const pages = Math.ceil(total / safeLimit);

    const safePage = pages > 0 ? Math.min(requestedPage, pages - 1) : 0;
    const offset = safePage * safeLimit;
    const rows = qcDb.prepare(`SELECT path, issues, reason FROM qc_cache WHERE ${where} ORDER BY pk_natural_key(path) LIMIT ? OFFSET ?`)
        .all(...params, safeLimit, offset);
    const items = rows.map(row => {
        let issues = [];
        try { issues = JSON.parse(row.issues); } catch (_) {}
        const seriesName = seriesNameFromPath(row.path, destRoot);
        let proposedName = null;
        let proposedPath = null;
        let renameCollision = false;
        if (issues.includes('bad_name') || issues.includes('special_needs_kavita_path')) {
            const chapter = parseQcChapterPath(row.path, seriesName);
            if (chapter && destRoot && isWithin(destRoot, row.path)) {
                const destination = buildChapterDestination(path.resolve(destRoot, seriesName), seriesName, chapter, { persistSpecial: true });
                proposedName = destination.fileName;
                proposedPath = destination.path;
                renameCollision = !samePath(row.path, proposedPath) && getPathPresence(proposedPath) === true;
            }
        }
        return {
            series: seriesName,
            file: path.basename(row.path),
            path: row.path,
            issues,
            reason: row.reason || '',
            proposedName,
            proposedPath,
            renameCollision
        };
    });
    return { items, total, page: safePage, limit: safeLimit, pages, series: selectedSeries };
}

function reconcileMissingConflicts(limit = 2000) {
    const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 2000));
    const { sourceRoot, destRoot } = getRoots();
    const accessibleRoots = [sourceRoot, destRoot].filter(Boolean).filter(root => {
        try { return fs.statSync(root).isDirectory(); }
        catch (_) { return false; }
    });
    if (!accessibleRoots.length) return { checked: 0, removed: 0, rootsAvailable: false };

    let rows = db.prepare("SELECT id, source_path FROM pending_conflicts WHERE status='pending' AND id>? ORDER BY id LIMIT ?")
        .all(conflictReconcileCursor, safeLimit);
    if (!rows.length && conflictReconcileCursor) {
        conflictReconcileCursor = 0;
        rows = db.prepare("SELECT id, source_path FROM pending_conflicts WHERE status='pending' ORDER BY id LIMIT ?").all(safeLimit);
    }
    if (rows.length) conflictReconcileCursor = rows[rows.length - 1].id;
    const update = db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='source_missing', updated_at=? WHERE id=? AND status='pending'");
    const now = new Date().toISOString();
    let removed = 0;
    const removedIds = [];
    for (const row of rows) {
        const sourcePath = path.resolve(row.source_path);
        if (!accessibleRoots.some(root => isWithin(root, sourcePath) && !samePath(root, sourcePath))) continue;
        let missing = false;
        try { fs.statSync(sourcePath); }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') missing = true;

        }
        if (missing) {
            const changes = update.run(now, row.id).changes;
            removed += changes;
            if (changes) removedIds.push(row.id);
        }
    }
    if (removed) log(`[CONFLICT CLEANUP] Automatically retired ${removed} stale conflict record(s) because their source files no longer exist. No files were deleted.`, 'INFO');
    return { checked: rows.length, removed, removedIds, rootsAvailable: true };
}

function removeStaleConflict(id) {
    const conflict = db.prepare("SELECT * FROM pending_conflicts WHERE id=? AND status='pending'").get(Number(id));
    if (!conflict) throw new Error('Pending conflict not found. It may already have been removed.');
    const sourcePath = path.resolve(conflict.source_path);
    const { sourceRoot, destRoot } = getRoots();
    const roots = [sourceRoot, destRoot].filter(Boolean);
    const rootAvailable = roots.some(root => {
        try { return isWithin(root, sourcePath) && fs.statSync(root).isDirectory(); }
        catch (_) { return false; }
    });
    if (!rootAvailable) throw new Error('The source/library location is not accessible. The record was left unchanged to avoid mistaking a disconnected drive for a missing file.');
    let sourceExists = false;
    try { fs.statSync(sourcePath); sourceExists = true; }
    catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
            throw new Error(`Could not verify that the source file is missing: ${error.message}`);
        }
    }
    if (sourceExists) throw new Error('The source file still exists. Use the normal conflict actions instead of removing this record.');
    db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='stale_removed', updated_at=? WHERE id=?")
        .run(new Date().toISOString(), conflict.id);
    log(`[CONFLICT CLEANUP] Removed stale conflict #${conflict.id}; source file was already missing. No files were deleted.`);
    return { success: true, message: 'Stale conflict record removed. No manga files were deleted.' };
}

async function fixLibraryIssues(fileList) {
    const { destRoot } = getRoots();
    if (!Array.isArray(fileList)) throw new Error('Expected a list of QC issues.');
    let fixed = 0;
    let sentToAttention = 0;
    let sentToConflicts = 0;
    let inspected = 0;
    const saveQcCache = qcDb.prepare(`INSERT INTO qc_cache (path, size, mtime, issues, reason, has_issues, scanned_at, parser_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime,
            issues=excluded.issues, reason=excluded.reason, has_issues=excluded.has_issues, scanned_at=excluded.scanned_at, parser_version=excluded.parser_version`);

    for (const item of fileList) {
        await yieldToPipeline();
        inspected++;
        if (!item || !item.path || !Array.isArray(item.issues)) continue;
        const fullPath = path.resolve(String(item.path));
        if (!isWithin(destRoot, fullPath) || !fullPath.toLowerCase().endsWith('.cbz')) {
            log(`[QC BLOCKED] Refused to modify a path outside the library: ${fullPath}`, 'ERROR');
            continue;
        }
        if (!(await fs.pathExists(fullPath))) {
            qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(fullPath);
            continue;
        }

        let currentPath = fullPath;
        const series = seriesNameFromPath(fullPath, destRoot);
        const remainingIssues = new Set(item.issues);
        let reason = String(item.reason || '');

        await yieldToPipeline();
        beginQcMutation();
        try {
            if (remainingIssues.has('special_needs_kavita_path')) {
                const special = parseQcChapterPath(currentPath, series);
                if (!special?.special) {
                    remainingIssues.delete('special_needs_kavita_path');
                } else {
                    const destination = buildChapterDestination(path.resolve(destRoot, series), series, special, { persistSpecial: true });
                    await fs.ensureDir(destination.directory);
                    if (!samePath(currentPath, destination.path) && getPathPresence(destination.path) === true) {
                        const id = savePendingConflict(currentPath, destination.path, series, special,
                            `QC assigned ${path.basename(destination.path)} to this Special, but that SP## destination already exists. Both files were preserved for review.`);
                        sentToConflicts++;
                        remainingIssues.delete('special_needs_kavita_path');
                        remainingIssues.delete('bad_name');
                        remainingIssues.delete('unparsed_chapter');
                        resolveFileIssue(currentPath);
                        log(`[QC SPECIAL → CONFLICT #${id}] ${path.basename(currentPath)} already has an SP## target; both copies were preserved.`, 'WARN');
                    } else if (!samePath(currentPath, destination.path)) {
                        const previousPath = currentPath;
                        await fs.move(previousPath, destination.path, { overwrite: false });
                        updateMovedFileReferences(previousPath, destination.path);
                        currentPath = destination.path;
                        remainingIssues.delete('special_needs_kavita_path');
                        remainingIssues.delete('bad_name');
                        remainingIssues.delete('unparsed_chapter');
                        resolveFileIssue(currentPath);
                        fixed++;
                        log(`[QC SPECIAL FIX] Moved and numbered Special: ${path.basename(previousPath)} -> ${path.basename(currentPath)}.`);
                    } else {
                        remainingIssues.delete('special_needs_kavita_path');
                    }
                }
            }

            if (remainingIssues.has('bad_name') || remainingIssues.has('unparsed_chapter')) {
                const chapter = parseQcChapterPath(currentPath, series);
                if (chapter) {
                    const newPath = path.join(path.dirname(currentPath), `${series} - ${chapter.label}.cbz`);
                    if (!samePath(currentPath, newPath) && await fs.pathExists(newPath)) {
                        const id = savePendingConflict(currentPath, newPath, series, chapter,
                            'Quality Control found a filename normalization collision; both library files were preserved.');
                        sentToConflicts++;

                        remainingIssues.delete('bad_name');
                        remainingIssues.delete('unparsed_chapter');
                        remainingIssues.delete('duplicate_chapter');
                        clearQcIssueFlag(newPath, 'duplicate_chapter');
                        resolveFileIssue(currentPath);
                        log(`[QC REVIEW #${id}] Rename would collide with an existing chapter; both files were preserved and the rename/duplicate review was transferred to Conflicts.`, 'WARN');
                    } else if (!samePath(currentPath, newPath)) {
                        await fs.move(currentPath, newPath, { overwrite: false });
                        qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(path.resolve(currentPath));
                        log(`[QC FIX] Renamed "${path.basename(currentPath)}" -> "${path.basename(newPath)}"`);
                        currentPath = newPath;
                        remainingIssues.delete('bad_name');
                        remainingIssues.delete('unparsed_chapter');
                        resolveFileIssue(currentPath);
                        fixed++;
                    } else {
                        remainingIssues.delete('bad_name');
                        remainingIssues.delete('unparsed_chapter');
                        resolveFileIssue(currentPath);
                    }
                } else {
                    const currentStats = await fs.stat(currentPath);
                    const attentionReason = `QC could not derive a safe chapter identifier from this filename: ${path.basename(currentPath)}. Assign the correct chapter/Special label in Files Needing Attention, or delete the file if it is not a chapter.`;
                    recordFileIssue(currentPath, 'unparsed_chapter', attentionReason, currentStats);
                    sentToAttention++;
                    remainingIssues.delete('bad_name');
                    remainingIssues.delete('unparsed_chapter');
                    log(`[QC → ATTENTION] Could not safely parse "${path.basename(currentPath)}". Sent it to Files Needing Attention for manual chapter assignment or deletion.`, 'WARN');
                }
            }

            if (remainingIssues.has('has_xml') && getComicInfoPolicy(series) !== 'leave') {
                try {
                    const result = await applyComicInfoPolicyToIncoming(currentPath, series);
                    if (result.missingTemplate) throw new Error(`The saved ${result.policy} policy requires a global or manga-specific ComicInfo template.`);
                    if (result.changed) {
                        log(`[QC FIX] Applied ComicInfo ${result.policy} to "${path.basename(currentPath)}".`);
                        fixed++;
                    }

                    remainingIssues.delete('has_xml');
                } catch (error) {
                    reason = `ComicInfo ${getComicInfoPolicy(series)} policy failed: ${error.message}`;
                    remainingIssues.delete('has_xml');
                    remainingIssues.add('xml_cleanup_failed');
                    log(`[QC COMICINFO POLICY FAILED] ${path.basename(currentPath)}: ${error.message}. Sent to Files Needing Attention.`, 'ERROR');
                }
            } else if (remainingIssues.has('has_xml')) {

                remainingIssues.delete('has_xml');
            }

            if (remainingIssues.has('duplicate_chapter')) {
                const chapter = parseQcChapterPath(currentPath, series);
                const collision = chapter ? await findChapterCollision(path.resolve(destRoot, series), series, chapter, currentPath) : null;
                if (collision) {
                    const conflictId = savePendingConflict(currentPath, collision, series, chapter,
                        `QC transferred this same-chapter collision to Chapter Conflicts. Both library files remain unchanged.`);
                    sentToConflicts++;
                    log(`[QC → CONFLICT #${conflictId}] Transferred ${path.basename(currentPath)} to Chapter Conflicts.`, 'WARN');
                }
                remainingIssues.delete('duplicate_chapter');
            }

            for (const issueName of ['bad_archive', 'unsupported_archive', 'xml_cleanup_failed', 'move_failed']) {
                if (!remainingIssues.has(issueName)) continue;
                const stats = await fs.stat(currentPath).catch(() => null);
                if (stats) {
                    const attentionReason = reason || `Quality Control detected ${issueName.replace(/_/g, ' ')}. Review the file in Files Needing Attention.`;
                    recordFileIssue(currentPath, issueName, attentionReason, stats);
                    sentToAttention++;
                }
                remainingIssues.delete(issueName);
                log(`[QC → ATTENTION] ${path.basename(currentPath)} was transferred to Files Needing Attention (${issueName}).`, 'WARN');
            }

            const stats = await fs.stat(currentPath).catch(() => null);
            if (stats) {
                saveQcCache.run(path.resolve(currentPath), stats.size, Math.floor(stats.mtimeMs),
                    JSON.stringify([...remainingIssues]), reason, remainingIssues.size ? 1 : 0, new Date().toISOString(), QC_ANALYSIS_VERSION);
            } else {
                qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(path.resolve(currentPath));
            }
        } catch (error) {
            const stats = await fs.stat(currentPath).catch(() => null);
            if (stats) {
                saveQcCache.run(path.resolve(currentPath), stats.size, Math.floor(stats.mtimeMs),
                    JSON.stringify([...remainingIssues]), error.message, 1, new Date().toISOString(), QC_ANALYSIS_VERSION);
            }
            log(`[QC ERROR] ${path.basename(currentPath)}: ${error.message}`, 'ERROR');
        } finally {
            endQcMutation();
        }
        if (inspected % 20 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    log(`QC fix pass finished. ${fixed} repair action(s) completed; ${sentToAttention} item(s) sent to Files Needing Attention; ${sentToConflicts} item(s) transferred to Chapter Conflicts.`);
    return { fixed, sentToAttention, sentToConflicts };
}

async function setManualChapterForIssueInternal(issueId, chapterInput, { deferPipeline = false } = {}) {
    if (pipelinePromise && !deferPipeline) throw new Error('A pipeline is already running. Save the chapter number after the current run finishes.');
    const issue = db.prepare("SELECT * FROM file_issues WHERE id=? AND status='pending'").get(Number(issueId));
    if (!issue) throw new Error('Pending Attention item not found.');
    if (!['unparsed_chapter', 'manual_chapter'].includes(issue.kind)) throw new Error('This item does not support manual chapter numbering.');

    const fullPath = path.resolve(issue.path);
    const { sourceRoot, destRoot } = getRoots();
    const inLibrary = Boolean(destRoot && isWithin(destRoot, fullPath) && !samePath(destRoot, fullPath));
    const inDownloads = Boolean(sourceRoot && isWithin(sourceRoot, fullPath) && !samePath(sourceRoot, fullPath));
    if (!inLibrary && !inDownloads) throw new Error('File path is outside the configured Download and Library folders. No changes were made.');
    if (path.extname(fullPath).toLowerCase() !== '.cbz' || !(await fs.pathExists(fullPath))) throw new Error('The CBZ file no longer exists at this path.');

    const mapping = inDownloads ? findMappedTargetForSourceFile(fullPath) : null;
    if (inDownloads && !mapping) throw new Error('No active mapping covers this source path. Map this source title in Series Mapper first.');
    const series = inLibrary ? seriesNameFromPath(fullPath, destRoot) : mapping.target_series;
    if (!series) throw new Error('Could not identify the target manga for this file.');
    const sourceChapter = parseSeriesChapter(portableBasename(fullPath), series);
    const parsedOverride = parseSeriesChapterLabel(chapterInput, series);
    const parsed = resolveChapterOverride(sourceChapter, parsedOverride, parsedOverride ? { chapter_label: parsedOverride.label, chapter_key: parsedOverride.key } : null, series);
    if (!parsed) throw new Error('Enter a chapter label such as 42, 42.5, 124b, Volume 02 Chapter 42, Special 1, or Special Creators Notes.');
    const now = new Date().toISOString();

    if (inLibrary) {
        if (!series) throw new Error('Could not identify the manga folder for this library file.');
        const seriesPath = path.resolve(destRoot, series);
        const destination = buildChapterDestination(seriesPath, series, parsed);
        await fs.ensureDir(destination.directory);
        const targetPath = destination.path;
        if (samePath(fullPath, targetPath)) {
            resolveFileIssue(fullPath);
            clearQcIssueFlag(fullPath, 'bad_name');
            clearQcIssueFlag(fullPath, 'duplicate_chapter');
            return { success: true, message: `The filename already matches ${parsed.label}. The Attention record was cleared.` };
        }

        if (await fs.pathExists(targetPath)) {
            const conflictId = savePendingConflict(fullPath, targetPath, series, parsed,
                `Manual chapter correction to ${parsed.label} collides with an existing file. Both versions were preserved for comparison.`);
            db.prepare("UPDATE file_issues SET status='transferred', reason=?, updated_at=? WHERE id=?")
                .run(`Transferred to Chapter Conflicts after the manual chapter correction collided with ${parsed.label}.`, now, issue.id);
            clearQcIssueFlag(fullPath, 'bad_name');
            clearQcIssueFlag(fullPath, 'duplicate_chapter');
            clearQcIssueFlag(targetPath, 'duplicate_chapter');
            log(`[ATTENTION → CONFLICT #${conflictId}] Manual chapter correction for ${path.basename(fullPath)} maps to ${series} - ${parsed.label}, which already exists. Both files were preserved.`, 'WARN');
            return { success: true, conflictId, message: `That chapter already exists. Both files were preserved and conflict #${conflictId} was created for comparison.` };
        }

        await fs.move(fullPath, targetPath, { overwrite: false });
        qcDb.prepare('DELETE FROM qc_cache WHERE path IN (?, ?)').run(fullPath, path.resolve(targetPath));
        db.prepare('DELETE FROM processed_files WHERE path=?').run(fullPath);
        db.prepare('UPDATE chapter_overrides SET path=? WHERE path=?').run(path.resolve(targetPath), fullPath);
        db.prepare('UPDATE cover_insertions SET archive_path=? WHERE archive_path=?').run(path.resolve(targetPath), fullPath);
        db.prepare("UPDATE file_issues SET status='fixed', reason=?, updated_at=? WHERE id=?")
            .run(`Renamed to ${path.basename(targetPath)} using the manual chapter correction.`, now, issue.id);
        await applyCoverRuleToFile(targetPath, series).catch(error => log(`[COVER APPLY WARN] ${path.basename(targetPath)}: ${error.message}`, 'WARN'));
        log(`[ATTENTION FIX] Manually corrected chapter: "${path.basename(fullPath)}" -> "${path.basename(targetPath)}".`);
        return { success: true, message: `Renamed to ${path.basename(targetPath)}. The manga file was not recompressed.` };
    }

    db.prepare(`INSERT INTO chapter_overrides (path, chapter_label, chapter_key, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET chapter_label=excluded.chapter_label, chapter_key=excluded.chapter_key, created_at=excluded.created_at`)
        .run(fullPath, parsed.label, parsed.key, now);
    db.prepare('UPDATE file_issues SET reason=?, updated_at=? WHERE id=?')
        .run(`Manual chapter set to ${parsed.label}; mapped to ${mapping.target_series}; waiting for processing.`, now, issue.id);
    log(`Manual chapter assigned: "${path.basename(fullPath)}" -> ${mapping.target_series} - ${parsed.label}.`);
    if (!deferPipeline) runPipeline().catch(error => log(`Manual chapter processing failed: ${error.message}`, 'ERROR'));
    return { success: true, queuedForProcessing: true, message: `Chapter set to ${parsed.label}.${deferPipeline ? ' Queued for the batch processing run.' : ' Processing started; an existing chapter will be queued for comparison.'}` };
}

async function setManualChapterForIssue(issueId, chapterInput) {
    await yieldToPipeline();
    beginQcMutation();
    try {
        return await setManualChapterForIssueInternal(issueId, chapterInput);
    } finally {
        endQcMutation();
    }
}

async function setManualChaptersForIssues(items) {
    if (!Array.isArray(items) || !items.length) throw new Error('Add at least one selected Attention item with a chapter name.');
    if (items.length > 250) throw new Error('Bulk chapter-name changes are limited to 250 items per batch.');
    await yieldToPipeline();
    let needsPipeline = false;
    let completed = 0;
    const failed = [];
    beginQcMutation();
    try {
        for (const item of items) {
            const id = Number(item?.id);
            const chapter = String(item?.chapter || '').trim();
            if (!Number.isSafeInteger(id) || id <= 0 || !chapter) {
                failed.push({ id: Number.isSafeInteger(id) ? id : null, error: 'Each item needs a valid ID and a non-empty chapter label.' });
                continue;
            }
            const issue = db.prepare("SELECT path FROM file_issues WHERE id=? AND status='pending'").get(id);
            if (!issue) {
                failed.push({ id, error: 'Pending Attention item not found.' });
                continue;
            }
            const { sourceRoot } = getRoots();
            if (sourceRoot && isWithin(sourceRoot, path.resolve(issue.path))) needsPipeline = true;
            try {
                await setManualChapterForIssueInternal(id, chapter, { deferPipeline: true });
                completed++;
            } catch (error) {
                failed.push({ id, error: error.message });
            }
            if (completed % 20 === 0) await new Promise(resolve => setImmediate(resolve));
        }
    } finally {
        endQcMutation();
    }
    if (needsPipeline && completed) runPipeline().catch(error => log(`Bulk manual chapter processing failed: ${error.message}`, 'ERROR'));
    return { success: failed.length === 0, completed, failed, pipelineStarted: Boolean(needsPipeline && completed), message: `${completed} chapter label(s) applied.${needsPipeline && completed ? ' Processing started once for the entire batch.' : ''}` };
}

async function createRecoverySnapshotForPath(originalPath, series) {
    const stats = await fs.stat(originalPath);
    const { destRoot } = getRoots();
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const safeSeries = String(series || 'Unsorted').replace(/[\/]/g, '_');
    const recoveryRoot = path.join(path.resolve(destRoot), '.panelkeeper-recovery', day, safeSeries);
    await fs.ensureDir(recoveryRoot);
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const backupPath = path.join(recoveryRoot, `${stamp}-before-page-edit-${path.basename(originalPath)}`);
    await fs.copyFile(originalPath, backupPath);
    const now = new Date().toISOString();
    try {
        const result = db.prepare(`INSERT INTO recovery_items (original_path, backup_path, series, created_at, size, status)
            VALUES (?, ?, ?, ?, ?, 'available')`)
            .run(path.resolve(originalPath), path.resolve(backupPath), String(series || 'Unsorted'), now, stats.size);
        return { id: Number(result.lastInsertRowid), originalPath: path.resolve(originalPath), backupPath, size: stats.size };
    } catch (error) {
        await fs.remove(backupPath).catch(() => {});
        throw error;
    }
}

async function createRecoveryForPath(originalPath, series, status = 'available') {
    const stats = await fs.stat(originalPath);
    const { destRoot } = getRoots();
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const recoveryRoot = path.join(path.resolve(destRoot), '.panelkeeper-recovery', day, String(series || 'Unsorted').replace(/[\\/]/g, '_'));
    await fs.ensureDir(recoveryRoot);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const backupPath = path.join(recoveryRoot, `${stamp}-${path.basename(originalPath)}`);
    await fs.move(originalPath, backupPath, { overwrite: false });
    const now = new Date().toISOString();
    try {
        const result = db.prepare(`INSERT INTO recovery_items (original_path, backup_path, series, created_at, size, status)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(path.resolve(originalPath), path.resolve(backupPath), String(series || 'Unsorted'), now, stats.size, status);
        return { id: Number(result.lastInsertRowid), originalPath: path.resolve(originalPath), backupPath, size: stats.size };
    } catch (error) {
        await fs.move(backupPath, originalPath, { overwrite: false }).catch(() => {});
        throw error;
    }
}

async function resolveConflictInternal(id, action) {
    const conflict = db.prepare("SELECT * FROM pending_conflicts WHERE id=? AND status='pending'").get(Number(id));
    if (!conflict) throw new Error('Pending conflict not found. It may already have been resolved.');
    const { sourceRoot, destRoot } = getRoots();
    if (!sourceRoot || !destRoot) throw new Error('Configure both paths in Settings before resolving this conflict.');
    const sourcePath = path.resolve(conflict.source_path);
    const existingPath = path.resolve(conflict.destination_path);
    const targetDir = path.resolve(destRoot, conflict.target_series);
    const sourceParsed = conflict.source_path ? getQueuedChapterForPath(conflict.source_path, conflict.target_series) : null;
    const conflictChapter = sourceParsed || parseSeriesChapterLabel(conflict.chapter_label, conflict.target_series) || {
        label: conflict.chapter_label,
        key: conflict.chapter_key,
        special: String(conflict.chapter_key || '').startsWith('special:')
    };
    const conflictDestination = buildChapterDestination(targetDir, conflict.target_series, conflictChapter);
    const canonicalPath = conflictDestination.path;
    if (!isWithin(destRoot, targetDir) || !isWithin(destRoot, canonicalPath)) throw new Error('Conflict has an invalid target path; no files were changed.');
    if (!(await fs.pathExists(sourcePath))) throw new Error('The downloaded/source file no longer exists. Refresh the queue before resolving it.');
    if (action === 'send_to_attention') {
        const allowed = [sourceRoot, destRoot].filter(Boolean).some(root => isWithin(root, sourcePath) && !samePath(root, sourcePath));
        if (!allowed || path.extname(sourcePath).toLowerCase() !== '.cbz') throw new Error('The conflict source is outside the configured CBZ locations. It was not transferred.');
        const stats = await fs.stat(sourcePath);
        recordFileIssue(sourcePath, 'manual_chapter', `Sent from Chapter Conflicts for manual review. Current chapter interpretation: ${conflict.chapter_label}. Check the filename and enter the correct chapter number here.`, stats);
        db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='sent_to_attention', updated_at=? WHERE id=?")
            .run(new Date().toISOString(), conflict.id);
        clearQcIssueFlag(sourcePath, 'bad_name');
        clearQcIssueFlag(sourcePath, 'duplicate_chapter');
        clearQcIssueFlag(existingPath, 'duplicate_chapter');
        log(`[CONFLICT #${id}] Sent ${path.basename(sourcePath)} to Files Needing Attention for manual chapter correction. Neither file was changed.`);
        return { success: true, message: 'Sent to Files Needing Attention. Both files are unchanged; edit the chapter number there.' };
    }
    if (action === 'use_download') {

        if (samePath(sourcePath, canonicalPath)) {
            db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='already_canonical', updated_at=? WHERE id=?")
                .run(new Date().toISOString(), conflict.id);
            log(`[CONFLICT #${id}] ${path.basename(sourcePath)} is already at its canonical library destination; closed the conflict without moving or deleting either file.`);
            return { success: true, message: 'The downloaded file is already at its canonical library destination. The conflict was closed without moving, replacing, or deleting either file.' };
        }
        await fs.ensureDir(conflictDestination.directory);
        const recoveryItems = [];
        const currentTargets = new Set([existingPath, canonicalPath]);
        try {
            for (const target of currentTargets) {
                if (samePath(target, sourcePath) || !(await fs.pathExists(target))) continue;
                recoveryItems.push(await createRecoveryForPath(target, conflict.target_series));
            }
            await fs.move(sourcePath, canonicalPath, { overwrite: false });
        } catch (error) {

            for (const recovered of recoveryItems.reverse()) {
                if (!(await fs.pathExists(recovered.originalPath)) && await fs.pathExists(recovered.backupPath)) {
                    await fs.move(recovered.backupPath, recovered.originalPath, { overwrite: false }).catch(() => {});
                    db.prepare("UPDATE recovery_items SET status='restored_after_error' WHERE id=?").run(recovered.id);
                }
            }
            throw new Error(`Could not replace the library copy: ${error.message}`);
        }
        db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='used_download', updated_at=? WHERE id=?")
            .run(new Date().toISOString(), conflict.id);
        db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(sourcePath);
        db.prepare('DELETE FROM processed_files WHERE path=?').run(sourcePath);
        db.prepare('UPDATE cover_insertions SET archive_path=? WHERE archive_path=?').run(path.resolve(canonicalPath), sourcePath);
        resolveFileIssue(sourcePath);

        qcDb.prepare('DELETE FROM qc_cache WHERE path IN (?, ?, ?)').run(sourcePath, existingPath, path.resolve(canonicalPath));
        await applyCoverRuleToFile(canonicalPath, conflict.target_series).catch(error => log(`[COVER APPLY WARN] ${path.basename(canonicalPath)}: ${error.message}`, 'WARN'));
        log(`[CONFLICT #${id}] Used the downloaded version for ${conflict.target_series} - ${conflict.chapter_label}. Previous library version moved to Recovery.`);
        return { success: true, message: 'Downloaded version is now in the library. The previous library version is in Recovery.' };
    }

    if (action === 'keep_library') {

        if (destRoot && isWithin(destRoot, sourcePath)) {
            await createRecoveryForPath(sourcePath, conflict.target_series, 'available');
        } else if (sourceRoot && isWithin(sourceRoot, sourcePath)) {
            await fs.remove(sourcePath);
            resolveFileIssue(sourcePath);
        } else {
            throw new Error('The source file is outside both configured roots. It was not deleted. Check Settings → Test Paths.');
        }
        db.prepare("UPDATE pending_conflicts SET status='resolved', resolution='kept_library', updated_at=? WHERE id=?")
            .run(new Date().toISOString(), conflict.id);
        db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(sourcePath);
        qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(sourcePath);
        db.prepare('DELETE FROM processed_files WHERE path=?').run(sourcePath);
        clearQcIssueFlag(existingPath, 'duplicate_chapter');
        resolveFileIssue(sourcePath);
        log(`[CONFLICT #${id}] Kept the existing library copy and removed/archived the incoming duplicate.`);
        return { success: true, message: 'The library version was kept. The duplicate was removed from Downloads or moved to Recovery.' };
    }
    throw new Error('Unknown conflict resolution.');
}

async function resolveConflict(id, action) {

    const conflict = db.prepare("SELECT target_series FROM pending_conflicts WHERE id=? AND status='pending'").get(Number(id));
    await yieldToPipeline();
    beginQcMutation();
    try {
        const result = await resolveConflictInternal(id, action);
        if (conflict?.target_series && db.prepare('SELECT 1 FROM library_series_state WHERE lower(series)=lower(?)').get(conflict.target_series)) {
            await waitForLibrarySeriesScan(conflict.target_series);
            await scanLibrarySeriesDirectory(conflict.target_series).catch(error => log(`[LIBRARY INVENTORY] Refresh failed for ${conflict.target_series}: ${error.message}`, 'WARN'));
        }
        return result;
    } finally {
        endQcMutation();
    }
}

async function resolveConflictsBulk(ids, action) {
    if (!['use_download', 'keep_library', 'send_to_attention'].includes(action)) throw new Error('Bulk action must be use_download, keep_library, or send_to_attention.');
    if (!Array.isArray(ids)) throw new Error('Bulk conflict IDs are required.');
    const uniqueIds = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 5000);
    let resolved = 0;
    const failed = [];
    for (let index = 0; index < uniqueIds.length; index++) {
        const id = uniqueIds[index];
        try {
            await resolveConflict(id, action);
            resolved++;
        } catch (error) {
            failed.push({ id, error: error.message });
        }
        if ((index + 1) % 5 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    log(`Bulk conflict action (${action}) completed: ${resolved}/${uniqueIds.length} resolved, ${failed.length} failed.`);
    return { success: failed.length === 0, total: uniqueIds.length, resolved, failed };
}

async function deleteFileIssue(id) {
    const issue = db.prepare("SELECT * FROM file_issues WHERE id=? AND status='pending'").get(Number(id));
    if (!issue) throw new Error('Pending attention item not found.');
    const { sourceRoot, destRoot } = getRoots();
    const fullPath = path.resolve(issue.path);
    const allowed = [sourceRoot, destRoot].filter(Boolean).some(root => isWithin(root, fullPath) && !samePath(root, fullPath));
    if (!allowed || path.extname(fullPath).toLowerCase() !== '.cbz') throw new Error('File path failed the source/library safety check; nothing was deleted.');
    if (await fs.pathExists(fullPath)) await fs.remove(fullPath);
    db.prepare("UPDATE file_issues SET status='deleted', updated_at=?, reason=? WHERE id=?")
        .run(new Date().toISOString(), 'File deleted from the Attention queue by the user.', issue.id);
    qcDb.prepare('DELETE FROM qc_cache WHERE path=?').run(fullPath);
    db.prepare('DELETE FROM processed_files WHERE path=?').run(fullPath);
    db.prepare('DELETE FROM chapter_overrides WHERE path=?').run(fullPath);
    log(`[ATTENTION] Deleted file from disk at the user's request: ${fullPath}`, 'WARN');
    return { success: true, message: 'The file was deleted and removed from the active Attention queue.' };
}

async function restoreRecoveryItem(id) {
    const item = db.prepare("SELECT * FROM recovery_items WHERE id=? AND status='available'").get(Number(id));
    if (!item) throw new Error('Recovery item not found or already used.');
    const { destRoot } = getRoots();
    if (!isWithin(destRoot, item.original_path) || !isWithin(path.join(destRoot, '.panelkeeper-recovery'), item.backup_path)) {
        throw new Error('Recovery paths failed the safety check. No files were changed.');
    }
    const backupPresence = getPathPresence(item.backup_path);
    if (backupPresence === null) throw new Error('The Recovery storage location is not accessible or its contents cannot be verified. The record was left unchanged.');
    if (backupPresence === false) throw new Error('The recovery file is confirmed missing from disk. You can remove its stale Recovery record with Delete Permanently.');
    await fs.ensureDir(path.dirname(item.original_path));
    let displaced = null;
    if (await fs.pathExists(item.original_path)) displaced = await createRecoveryForPath(item.original_path, item.series);
    try {
        await fs.move(item.backup_path, item.original_path, { overwrite: false });
    } catch (error) {
        if (displaced && !(await fs.pathExists(displaced.originalPath)) && await fs.pathExists(displaced.backupPath)) {
            await fs.move(displaced.backupPath, displaced.originalPath, { overwrite: false }).catch(() => {});
        }
        throw new Error(`Could not restore file: ${error.message}`);
    }
    db.prepare("UPDATE recovery_items SET status='restored' WHERE id=?").run(item.id);
    log(`[RECOVERY] Restored "${path.basename(item.original_path)}". ${displaced ? 'The current version was moved into Recovery.' : ''}`);
    return { success: true, message: displaced ? 'Previous version restored; the replaced version is now in Recovery.' : 'File restored.' };
}

async function deleteRecoveryItem(id) {
    const item = db.prepare("SELECT * FROM recovery_items WHERE id=? AND status='available'").get(Number(id));
    if (!item) throw new Error('Recovery item not found or already removed.');
    const backupPresence = getPathPresence(item.backup_path);
    if (backupPresence === null) throw new Error('The Recovery storage location is not accessible or its contents cannot be verified. The record was left unchanged.');
    if (backupPresence === false) {
        db.prepare("UPDATE recovery_items SET status='deleted' WHERE id=?").run(item.id);
        log(`[RECOVERY] Removed stale index record #${item.id}; its backup file was already missing.`, 'WARN');
        return { success: true };
    }
    await fs.remove(item.backup_path);
    db.prepare("UPDATE recovery_items SET status='deleted' WHERE id=?").run(item.id);
    log(`[RECOVERY] Permanently deleted "${path.basename(item.backup_path)}" at the user's request.`);
    return { success: true };
}

async function bulkRecoveryAction(ids, action) {
    if (!['restore', 'delete'].includes(action)) throw new Error('Recovery action must be restore or delete.');
    if (!Array.isArray(ids)) throw new Error('Recovery item IDs are required.');
    const uniqueIds = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!uniqueIds.length) throw new Error('No Recovery items were selected.');
    if (uniqueIds.length > 5000) throw new Error('Bulk Recovery actions are limited to 5,000 items at a time. Narrow the filters and run another batch.');
    let completed = 0;
    const failed = [];
    for (let index = 0; index < uniqueIds.length; index++) {
        const id = uniqueIds[index];
        try {
            if (action === 'restore') await restoreRecoveryItem(id);
            else await deleteRecoveryItem(id);
            completed++;
        } catch (error) {
            failed.push({ id, error: error.message });
        }
        if ((index + 1) % 5 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    log(`[RECOVERY] Bulk ${action} action completed: ${completed}/${uniqueIds.length}, ${failed.length} failed.`);
    return { success: failed.length === 0, total: uniqueIds.length, completed, failed };
}

async function purgeExpiredRecovery() {
    const days = Math.max(1, Math.min(365, Number(getSetting('backupRetentionDays', '14')) || 14));
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = db.prepare("SELECT * FROM recovery_items WHERE status='available'").all();
    let count = 0;
    for (const item of rows) {
        const created = Date.parse(item.created_at);
        if (!Number.isFinite(created) || created >= threshold) continue;
        const presence = getPathPresence(item.backup_path);
        if (presence === null) continue;
        if (presence === true) {
            try { await fs.remove(item.backup_path); }
            catch (error) { log(`[RECOVERY] Could not expire ${item.backup_path}: ${error.message}`, 'WARN'); continue; }
        }
        db.prepare("UPDATE recovery_items SET status='expired' WHERE id=?").run(item.id);
        count++;
    }
    if (count) log(`Recovery retention: permanently removed ${count} item(s) older than ${days} days.`);
}

async function getPathStatus() {
    const { sourceRoot, destRoot } = getRoots();
    async function check(label, configuredPath, mustWrite = false) {
        if (!configuredPath) return { label, path: configuredPath, accessible: false, message: 'No path configured.' };
        try {
            const stats = await fs.stat(configuredPath);
            if (!stats.isDirectory()) return { label, path: configuredPath, accessible: false, message: 'The path exists but is not a directory.' };
            await fs.access(configuredPath, mustWrite ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK);
            return { label, path: configuredPath, accessible: true, message: mustWrite ? 'Directory is readable and writable by this server process.' : 'Directory is readable by this server process.' };
        } catch (error) {
            let message = error.message;
            if (process.platform === 'win32' && /^[A-Za-z]:/.test(configuredPath)) {
                message += ' Mapped drives are per-user/per-session on Windows; run the server under the account that mapped this drive, or use a UNC path such as \\\\server\\share\\folder.';
            }
            return { label, path: configuredPath, accessible: false, message };
        }
    }
    return {
        source: await check('Source Root', sourceRoot, true),
        destination: await check('Destination', destRoot, true),
        server: { platform: process.platform, node: process.version, cwd: process.cwd(), appDirectory: APP_DIR, database: db.name }
    };
}

async function scanSeries() {
    const { sourceRoot, destRoot } = getRoots();
    if (!sourceRoot || !destRoot) throw new Error('Paths not set. Configure Source Root and Destination in Settings.');
    if (!(await fs.pathExists(sourceRoot))) throw new Error(`Source root is not accessible: "${sourceRoot}". Use Settings → Test Paths.`);
    if (!(await fs.pathExists(destRoot))) throw new Error(`Destination is not accessible: "${destRoot}". Use Settings → Test Paths.`);
    const destSeries = (await fs.readdir(destRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && isLibrarySeriesFolderName(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const destSet = new Set(destSeries.map(name => name.trim().toLowerCase()));

    const destinationChapterCounts = new Map();
    for (const seriesName of destSeries) {
        try {
            const entries = await fs.readdir(path.join(destRoot, seriesName), { withFileTypes: true });
            destinationChapterCounts.set(seriesName.trim().toLowerCase(), entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz').length);
        } catch (_) { destinationChapterCounts.set(seriesName.trim().toLowerCase(), null); }
    }
    const sourceSeries = await discoverSourceSeries(path.resolve(sourceRoot), path.resolve(destRoot));
    const sourceGroups = new Map();
    for (const source of sourceSeries) {
        const key = source.name.trim().toLowerCase();
        if (!sourceGroups.has(key)) sourceGroups.set(key, []);
        sourceGroups.get(key).push(source);
    }

    let existingMappings = db.prepare('SELECT * FROM series_mappings').all();

    autoAttachExactTitlePaths(sourceSeries, existingMappings);

    let activeBySource = new Map();
    for (const mapping of existingMappings.filter(item => item.active)) {
        const key = mapping.source_folder.trim().toLowerCase();
        if (!activeBySource.has(key)) activeBySource.set(key, []);
        activeBySource.get(key).push(mapping);
    }

    for (const [key, candidates] of sourceGroups) {
        if (activeBySource.has(key) || !candidates.length) continue;
        const exact = destSeries.find(name => name.trim().toLowerCase() === key);
        if (!exact) continue;
        const source = candidates[0];
        try {
            const now = new Date().toISOString();
            const result = db.prepare('INSERT INTO series_mappings (source_folder, target_series, active, source_path, source_file_count, source_last_seen) VALUES (?, ?, 1, ?, ?, ?)')
                .run(source.name, exact, path.resolve(source.path), source.count, now);
            const mappingId = Number(result.lastInsertRowid);
            const mapping = { id: mappingId, source_folder: source.name, target_series: exact, active: 1, source_path: path.resolve(source.path) };
            db.prepare('INSERT OR IGNORE INTO series_mapping_sources (mapping_id, source_folder, source_path, source_file_count, last_seen) VALUES (?, ?, ?, ?, ?)')
                .run(mappingId, source.name, path.resolve(source.path), source.count, now);
            activeBySource.set(key, [mapping]);
            autoAttachExactTitlePaths(candidates, [mapping]);
            log(`Auto-mapped exact folder title: "${source.name}" -> "${exact}" (${candidates.length} physical path(s)).`);
        } catch (error) {
            log(`Could not auto-map exact source title "${source.name}": ${error.message}`, 'WARN');
        }
    }

    existingMappings = db.prepare('SELECT * FROM series_mappings ORDER BY pk_natural_key(target_series), pk_natural_key(source_folder)').all();
    const allSavedSources = db.prepare('SELECT * FROM series_mapping_sources ORDER BY pk_natural_key(source_folder), pk_natural_key(source_path)').all();
    const sourcesByMapping = new Map();
    const mappedPathKeys = new Set();
    for (const source of allSavedSources) {
        if (!sourcesByMapping.has(source.mapping_id)) sourcesByMapping.set(source.mapping_id, []);
        const matches = sourceSeries.find(item => samePath(item.path, source.source_path));
        const record = { ...source, exists: Boolean(matches), current_count: matches?.count ?? source.source_file_count };
        sourcesByMapping.get(source.mapping_id).push(record);
        mappedPathKeys.add(pathKey(source.source_path));
    }
    for (const mapping of existingMappings) {
        if (mapping.source_path) mappedPathKeys.add(pathKey(mapping.source_path));
    }

    const mappings = existingMappings.map(mapping => {
        const candidates = sourceGroups.get(mapping.source_folder.trim().toLowerCase()) || [];
        const sourcePaths = sourcesByMapping.get(mapping.id) || [];
        const currentPaths = sourcePaths.filter(item => item.exists);
        const unassignedCandidates = candidates.filter(item => !mappedPathKeys.has(pathKey(item.path)));
        return {
            ...mapping,
            source_paths: sourcePaths,
            source_path: currentPaths[0]?.source_path || mapping.source_path || '',
            source_path_candidates: unassignedCandidates.map(item => path.resolve(item.path)),
            source_path_ambiguous: unassignedCandidates.length > 0,
            destination_path: path.resolve(destRoot, mapping.target_series),
            destination_chapter_count: destinationChapterCounts.get(mapping.target_series.trim().toLowerCase()) ?? 0,
            source_file_count: currentPaths.reduce((sum, item) => sum + Number(item.current_count || 0), 0),
            source_exists: currentPaths.length > 0,
            destination_exists: destSet.has(mapping.target_series.trim().toLowerCase()),

            volume_mode: getSeriesVolumeMode(mapping.target_series),
            ignored_terms: getSeriesIgnoredTerms(mapping.target_series)
        };
    });
    const unmatchedSourceDetails = sourceSeries.filter(source => !mappedPathKeys.has(pathKey(source.path)))
        .map(source => ({ name: source.name, path: path.resolve(source.path), count: source.count }));
    const unmatchedSources = unmatchedSourceDetails.map(source => source.name);
    return { destinationSeries: destSeries, unmatchedSources, unmatchedSourceDetails, mappings, sourceFolders: sourceSeries.length };
}

async function runPipeline() {
    if (pipelinePromise) {
        log('Pipeline request ignored because another pipeline run is already in progress.', 'WARN');
        return pipelinePromise;
    }
    pipelineGeneration++;
    pipelinePromise = (async () => {
        const startedAt = Date.now();
        log('Pipeline started.');
        try {

            await waitForQcMutations();
            await waitForCoverMutations();
            const moveResult = await moveAndRename();
            if (moveResult && moveResult.processed === false) {
                log(`Pipeline stopped before modifying the library (${moveResult.reason || 'path check failed'}).`, 'ERROR');
                const reason = moveResult.reason || 'path_check_failed';
                const alert = await sendNotification('', { event: 'pipeline_not_run', details: { reason } });
                if (!alert.sent && !alert.skipped && alert.reason && !alert.reason.startsWith('No Home Assistant')) log(`Failure webhook not sent: ${alert.reason}`, 'WARN');
                return { success: false, reason };
            }
            await auditAndFixLibrary();
            await normalizeRootSpecialFiles();
            await refreshTouchedLibrarySeries();

            const autoQcEnabled = String(getSetting('autoQC', 'false')) === 'true';
            if (autoQcEnabled) {
                const intervalHours = Math.max(1, Math.min(720, Number(getSetting('autoQCIntervalHours', '168')) || 168));
                const lastRun = Date.parse(getSetting('lastAutoQC', ''));
                const due = !Number.isFinite(lastRun) || Date.now() - lastRun >= intervalHours * 60 * 60 * 1000;
                if (due) {
                    startQcScan({ reason: 'scheduled automatic QC', autoFix: true, useCache: true });
                    log(`Automatic QC was started separately in the background (due every ${intervalHours} hour(s)); the pipeline will not wait for it.`);
                } else {
                    log(`Automatic QC is enabled; the next full background pass is due in ${intervalHours} hour(s) from the previous pass.`);
                }
            } else {
                log('Automatic QC is off. No full-library scan was started.');
            }
            await purgeExpiredRecovery();
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            log(`Pipeline finished in ${elapsed}s.`);
            await sendNotification('', {
                event: 'pipeline_completed',
                details: { elapsedSeconds: elapsed, folders: moveResult?.folders, matched: moveResult?.matched }
            }).then(result => {
                if (result.sent) log(`Home Assistant webhook request returned HTTP ${result.status}; automation execution is not confirmed by the webhook response (test/event ID ${result.testId || 'n/a'}).`);
                else if (!result.skipped && result.reason && !result.reason.startsWith('No Home Assistant webhook URL is configured')) log(`Webhook request not completed: ${result.reason}`, 'WARN');
            });
            return { success: true, elapsedSeconds: elapsed };
        } catch (error) {
            log(`Pipeline failed: ${error.stack || error.message}`, 'ERROR');
            try {
                const alert = await sendNotification('', { event: 'pipeline_failed', details: { reason: error.message } });
                if (alert.sent) log(`Failure webhook request returned HTTP ${alert.status}; Home Assistant automation execution is not confirmed.`);
                else if (!alert.skipped && alert.reason && !alert.reason.startsWith('No Home Assistant')) log(`Failure webhook request not completed: ${alert.reason}`, 'WARN');
            } catch (notifyError) { log(`Could not send pipeline failure webhook: ${notifyError.message}`, 'WARN'); }
            throw error;
        } finally {
            pipelinePromise = null;
            setImmediate(processCoverJobs);
        }
    })();
    return pipelinePromise;
}

function isPipelineRunning() {
    return Boolean(pipelinePromise);
}

module.exports = {
    runPipeline,
    isPipelineRunning,
    moveAndRename,
    auditAndFixLibrary,
    applyComicInfoPolicyToLibrary,
    scanLibraryHealth,
    startQcScan,
    resumeInterruptedQcScan,
    getQcScanStatus,
    getLatestQcScanStatus,
    getQcIssueSummary,
    getQcResults,
    dismissQcIssue,
    dismissQcIssues,
    getIssueProposal,
    previewIssueProposal,
    reconcileQueuedChapterItems,
    getConflictProposal,
    getQcSeriesFilters,
    getIssueSeriesFilters,
    getSeriesPendingCounts,
    fixLibraryIssues,
    reconcileMissingConflicts,
    removeStaleConflict,
    resolveConflict,
    resolveConflictsBulk,
    setManualChapterForIssue,
    setManualChaptersForIssues,
    deleteFileIssue,
    getIssueArchivePages,
    getIssueArchivePage,
    deleteIssueArchivePage,
    reorderIssueArchivePages,
    getLibraryArchivePages,
    getLibraryArchivePage,
    deleteLibraryArchivePage,
    reorderLibraryArchivePages,
    getRecoveryArchivePages,
    getRecoveryArchivePage,
    deleteRecoveryArchivePage,
    reorderRecoveryArchivePages,
    restoreRecoveryItem,
    deleteRecoveryItem,
    bulkRecoveryAction,
    getPathStatus,
    getPathPresence,
    scanSeries,
    listLibrarySeries,
    getLibraryOverviewStats,
    getLibrarySeriesDetail,
    startLibraryCatalogScan,
    resumeLibraryCatalogScan,
    catalogJobStatus,
    scanLibrarySeriesDirectory,
    refreshLibrarySeriesForCompletion,
    setLibrarySeriesMetadata,
    getSeriesVolumeMode,
    setSeriesVolumeMode,
    getGlobalIgnoredTerms,
    setGlobalIgnoredTerms,
    getSeriesIgnoredTerms,
    getEffectiveIgnoredTerms,
    setSeriesIgnoredTerms,
    renameSeriesIgnoredTerms,
    parseQcChapterPath,
    parseChapterRangeInput,
    renameSeriesVolumeMode,
    parseSeriesChapter,
    renameLibrarySeries,
    deleteLibraryChaptersToRecovery,
    renameLibraryChapter,
    listCoverSeries,
    getComicInfoTemplates,
    saveComicInfoTemplate,
    listComicInfoSeries,
    listComicInfoArchives,
    getComicInfoArchive,
    previewComicInfoTemplateForArchive,
    getComicInfoChapterContext,
    saveComicInfoArchive,
    applyComicInfoPolicyToSeries,
    applyComicInfoPolicyToArchive,
    applyComicInfoPolicyToReviewFile,
    fetchComicInfoKavitaMetadata,
    getComicInfoPolicy,
    getKavitaConnectionStatus,
    saveKavitaConnection,
    searchKavitaSeries,
    findKavitaSeriesMatch,
    getKavitaCoverSettings,
    getKavitaSeriesCoverPreview,
    saveChapterCoverSettings,
    saveKavitaSeriesCoverSource,
    downloadKavitaMainCover,
    setKavitaAutoCover,
    importSeriesCoverImage,
    getCoverPreview,
    getCoverPreviewCandidate,
    getCoverPreviewPage,
    startCoverUpdateJob,
    getCoverJobStatus,
    getLatestCoverJob,
    startKavitaAutoCoverBulkJob,
    getKavitaAutoCoverBulkJob,
    cancelKavitaAutoCoverBulkJob,
    resumeKavitaAutoCoverBulkJobs,
    resumeCoverUpdateJobs,
    renameSeriesCoverRule,
    processCoverJobs,
    getChapterCoverDesign,
    getChapterCoverDesignPreview,
    saveChapterCoverDesign,
    getChapterCoverJobStatus,
    getLatestChapterCoverJob,
    resumeChapterCoverJobs,
    processChapterCoverJobs,
    walkCbzFiles,
    getSetting,
    log,
    sendNotification,
    parseChapter,
    parseChapterLabel,
    extractDownloaderCopyNumber,
    extractChapterInfo,
    validateSeriesName,
    isWithin,
    getRoots,
    zip
};
