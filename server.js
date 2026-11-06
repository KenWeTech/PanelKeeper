'use strict';

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs-extra');
const db = require('./database');
const qcDb = require('./qc-database');
const manager = require('./manager');
const { resolveSchedulerTimezone, schedulerDateValue, elapsedSecondsBetween, resolveElapsedSeconds, calculateNextCronRun, describeCronSchedule, parseScheduleStartTime, buildPresetCron, normalizeScheduleStartTime, cronRunsAtMidnight, inferSchedulePreset } = require('./utils/scheduler-utils');

const app = express();
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT || 7001)));
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');
let scheduledTask = null;
let scheduledNextRunAt = null;
let scheduledNextRunError = '';
const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

app.use(express.static(PUBLIC_DIR, { index: false, fallthrough: true }));
app.get('/', (req, res) => res.sendFile(INDEX_PATH));
app.get('/favicon.ico', (req, res) => res.status(204).end());

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sendError(res, error, status = 500) {
    res.status(status).json({ error: error?.message || String(error) });
}

async function streamArchiveEntry(res, archivePage) {
    const stream = await manager.zip.createEntryReadStream(archivePage.archivePath, archivePage.entry);
    res.setHeader('Content-Type', manager.zip.mimeTypeForImage(archivePage.entry.name));
    res.setHeader('Content-Length', String(archivePage.entry.uncompressedSize));
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', error => {
        manager.log(`Archive page preview failed for ${path.basename(archivePage.archivePath)} (${archivePage.entry.name}): ${error.message}`, 'WARN');
        if (!res.headersSent) res.status(500);
        res.destroy(error);
    });
    stream.pipe(res);
}

function getPagination(req) {
    const page = Math.max(0, Math.min(100000, Number.parseInt(req.query.page || '0', 10) || 0));
    const limit = Math.max(10, Math.min(250, Number.parseInt(req.query.limit || '25', 10) || 25));
    return { page, limit, offset: page * limit };
}

function addPatternSearch(conditions, params, rawSearch, columns) {
    const search = String(rawSearch ?? '').slice(0, 200);

    if (!search.length) return;
    conditions.push(`(${columns.map(column => `pk_pattern_match(${column}, ?) = 1`).join(' OR ')})`);
    params.push(...columns.map(() => search));
}

function parseSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));

    delete settings.kavitaApiKey;
    settings.kavitaConfigured = Boolean(settings.kavitaBaseUrl && rows.some(row => row.key === 'kavitaApiKey' && String(row.value || '').trim()));
    if (!settings.schedulerTimezone) settings.schedulerTimezone = 'system';
    const inferred = inferSchedulePreset(settings.cronSchedule || '');
    const storedPreset = String(settings.schedulePreset || '');
    const storedStart = settings.scheduleStartTime || inferred.startTime || '02:30';
    const knownPresets = ['off', 'hourly', 'every2Hours', 'every4Hours', 'every6Hours', 'daily', 'weeklySunday', 'custom'];
    let effectivePreset = knownPresets.includes(storedPreset) ? storedPreset : inferred.preset;
    let effectiveStart = storedStart;
    if (effectivePreset === 'off') {
        settings.cronSchedule = '';
    } else if (effectivePreset !== 'custom') {
        try {
            if (buildPresetCron(effectivePreset, effectiveStart) !== String(settings.cronSchedule || '')) {
                effectivePreset = inferred.preset;
                effectiveStart = inferred.startTime || '02:30';
            }
        } catch (_) {
            effectivePreset = inferred.preset;
            effectiveStart = inferred.startTime || '02:30';
        }
    }

    settings.schedulePreset = effectivePreset || 'custom';
    settings.scheduleStartTime = effectiveStart;
    settings.scheduleValid = effectivePreset === 'off' || cron.validate(String(settings.cronSchedule || ''));
    for (const key of ['pipelineOrder', 'cleanWords']) {
        if (settings[key]) {
            try { settings[key] = JSON.parse(settings[key]); }
            catch (_) { settings[key] = []; }
        }
    }
    return settings;
}

function saveSchedulerState(values) {
    const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [key, value] of Object.entries(values)) stmt.run(key, value == null ? '' : String(value));
}

function getSchedulerTimezone() {
    try {
        return resolveSchedulerTimezone(manager.getSetting('schedulerTimezone', 'system'), systemTimezone);
    } catch (_) {
        return systemTimezone;
    }
}

function getSchedulerStatus() {
    const cronSchedule = String(manager.getSetting('cronSchedule', '30 2,6,10,14,18,22 * * *')).trim();
    const schedulePreset = String(manager.getSetting('schedulePreset', '') || '');
    let nextRunAt = null;
    let taskStatus = 'unavailable';
    let schedulerLastRunAt = null;
    let schedulerLastRunError = '';
    try {
        if (schedulePreset === 'off') taskStatus = 'off';

        if (schedulePreset !== 'off' && scheduledTask) {
            if ((!scheduledNextRunAt && !scheduledNextRunError) || (scheduledNextRunAt && Date.parse(scheduledNextRunAt) <= Date.now())) {
                try {
                    scheduledNextRunAt = calculateNextCronRun(cronSchedule, new Date(), getSchedulerTimezone());
                    if (!scheduledNextRunAt) throw new Error('No occurrence was found within the next eight years for this schedule.');
                    scheduledNextRunError = '';
                } catch (error) {
                    scheduledNextRunAt = null;
                    scheduledNextRunError = error.message;
                }
            }
            nextRunAt = scheduledNextRunAt;
        }
        if (schedulePreset !== 'off') {
            taskStatus = scheduledTask?.getStatus?.() || (scheduledTask ? 'active' : 'stopped');
            const taskLastRun = scheduledTask?.lastRun?.();
            if (taskLastRun) {
                schedulerLastRunAt = schedulerDateValue(taskLastRun.date);
                schedulerLastRunError = taskLastRun.error?.message || '';
            }
        }
    } catch (error) {
        taskStatus = `error: ${error.message}`;
    }

    const taskStatusLabel = taskStatus === 'off'
        ? 'Off · no automatic runs'
        : taskStatus === 'idle'
        ? 'Active · waiting for next run'
        : taskStatus === 'running'
            ? 'Scheduled callback running'
            : taskStatus === 'stopped' || taskStatus === 'destroyed'
                ? 'Stopped'
                : taskStatus === 'unavailable'
                    ? 'Unavailable'
                    : taskStatus;

    const pipelineRunAt = manager.getSetting('lastPipelineRunAt', '') || '';
    const hasPipelineRun = Boolean(pipelineRunAt);
    const lastRunAt = pipelineRunAt || null;
    const lastFinishedAt = hasPipelineRun
        ? (manager.getSetting('lastPipelineFinishedAt', '') || null)
        : null;
    const lastElapsedSeconds = resolveElapsedSeconds(
        manager.getSetting('lastPipelineElapsedSeconds', ''),
        lastRunAt,
        lastFinishedAt
    );
    return {
        cronSchedule,
        schedulePreset,
        scheduleStartTime: manager.getSetting('scheduleStartTime', inferSchedulePreset(cronSchedule).startTime),
        scheduleDescription: schedulePreset === 'off' ? 'Automation is off' : describeCronSchedule(cronSchedule),
        enabled: schedulePreset !== 'off' && Boolean(scheduledTask) && !['stopped', 'destroyed'].includes(taskStatus),
        taskStatus,
        taskStatusLabel,
        timezone: getSchedulerTimezone(),
        nextRunAt,
        schedulerLastRunAt,
        schedulerLastRunError,
        nextRunError: scheduledNextRunError,
        lastRunAt,
        lastFinishedAt,
        lastElapsedSeconds,
        lastTrigger: hasPipelineRun
            ? (manager.getSetting('lastPipelineTrigger', '') || 'manual')
            : '',
        lastStatus: hasPipelineRun
            ? (manager.getSetting('lastPipelineStatus', '') || 'running')
            : 'never',
        lastMessage: hasPipelineRun
            ? (manager.getSetting('lastPipelineMessage', '') || '')
            : ''
    };
}

function refreshScheduler() {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
    }
    scheduledNextRunAt = null;
    scheduledNextRunError = '';
    let schedule = String(manager.getSetting('cronSchedule', '30 2,6,10,14,18,22 * * *')).trim();
    const timezone = getSchedulerTimezone();
    if (String(manager.getSetting('schedulePreset', '') || '') === 'off') {
        saveSchedulerState({ cronSchedule: '', schedulePreset: 'off' });
        return;
    }
    if (!cron.validate(schedule)) {
        manager.log(`Scheduled task was not enabled because the cron expression is invalid: "${schedule}"`, 'ERROR');
        return;
    }
    if (cronRunsAtMidnight(schedule)) {
        const inferred = inferSchedulePreset(schedule);
        const savedPreset = String(manager.getSetting('schedulePreset', '') || '');
        if (savedPreset === 'custom' || inferred.preset === 'custom') {
            scheduledNextRunError = "This custom cron schedule includes 00:00. Choose a different time so it does not overlap Kavita's midnight scan.";
            manager.log(`Scheduled task was not enabled because custom cron "${schedule}" includes 00:00 and conflicts with the midnight scan window.`, 'ERROR');
            return;
        }
        const safeStartTime = normalizeScheduleStartTime(inferred.preset, inferred.startTime || '02:30');
        schedule = buildPresetCron(inferred.preset, safeStartTime);
        saveSchedulerState({ schedulePreset: inferred.preset, scheduleStartTime: safeStartTime, cronSchedule: schedule });
        manager.log(`Adjusted the saved ${inferred.preset} schedule to ${safeStartTime} to avoid an exact-midnight run while preserving its cadence.`, 'WARN');
    }
    try {
        scheduledNextRunAt = calculateNextCronRun(schedule, new Date(), timezone);
        if (!scheduledNextRunAt) throw new Error('No occurrence was found within the next eight years for this schedule.');
    } catch (error) {
        scheduledNextRunAt = null;
        scheduledNextRunError = error.message;
        manager.log(`Could not calculate the next scheduled run for "${schedule}": ${error.message}`, 'WARN');
    }
    scheduledTask = cron.schedule(schedule, async () => {
        const startedAt = new Date().toISOString();
        try {
            scheduledNextRunAt = calculateNextCronRun(schedule, new Date(), timezone);
            if (!scheduledNextRunAt) throw new Error('No occurrence was found within the next eight years for this schedule.');
            scheduledNextRunError = '';
        } catch (error) {
            scheduledNextRunAt = null;
            scheduledNextRunError = error.message;
        }
        if (manager.isPipelineRunning()) {
            saveSchedulerState({
                lastScheduledAttemptAt: startedAt,
                lastScheduledAttemptStatus: 'skipped',
                lastScheduledAttemptMessage: 'Skipped because a pipeline was already running.'
            });
            manager.log('Scheduled run skipped because the pipeline was already running.', 'WARN');
            return;
        }
        saveSchedulerState({
            lastScheduledRunAt: startedAt,
            lastScheduledFinishedAt: '',
            lastScheduledStatus: 'running',
            lastScheduledMessage: 'Scheduled pipeline is running.',
            lastPipelineRunAt: startedAt,
            lastPipelineFinishedAt: '',
            lastPipelineElapsedSeconds: '',
            lastPipelineTrigger: 'scheduled',
            lastPipelineStatus: 'running',
            lastPipelineMessage: 'Scheduled pipeline is running.'
        });
        manager.log(`Starting scheduled pipeline (${schedule}, ${timezone}).`);
        try {
            const result = await manager.runPipeline();
            const finishedAt = new Date().toISOString();
            const success = result?.success !== false;
            const elapsed = Number.isFinite(Number(result?.elapsedSeconds)) && result?.elapsedSeconds !== undefined
                ? Math.max(0, Number(result.elapsedSeconds))
                : (elapsedSecondsBetween(startedAt, finishedAt) ?? 0);
            const message = success ? `Completed in ${elapsed} second(s).` : `Stopped without completing: ${result?.reason || 'pipeline returned an unsuccessful result'}.`;
            saveSchedulerState({
                lastScheduledFinishedAt: finishedAt,
                lastScheduledStatus: success ? 'completed' : 'failed',
                lastScheduledMessage: message,
                lastPipelineFinishedAt: finishedAt,
                lastPipelineElapsedSeconds: elapsed,
                lastPipelineStatus: success ? 'completed' : 'failed',
                lastPipelineMessage: message
            });
        } catch (error) {
            const finishedAt = new Date().toISOString();
            const elapsed = elapsedSecondsBetween(startedAt, finishedAt) ?? 0;
            saveSchedulerState({
                lastScheduledFinishedAt: finishedAt,
                lastScheduledStatus: 'failed',
                lastScheduledMessage: error.message,
                lastPipelineFinishedAt: finishedAt,
                lastPipelineElapsedSeconds: elapsed,
                lastPipelineStatus: 'failed',
                lastPipelineMessage: error.message
            });
            manager.log(`Scheduled pipeline failed: ${error.message}`, 'ERROR');
        }
    }, { name: 'panelkeeper-pipeline', timezone, noOverlap: true });
    manager.log(`Automation schedule active: ${describeCronSchedule(schedule)} (${schedule}; ${timezone}); next run ${scheduledNextRunAt || 'not available'}.`);
}

app.get('/api/health', (req, res) => res.json({ ok: true, running: manager.isPipelineRunning(), version: require('./package.json').version }));

app.get('/api/logs', (req, res) => {
    try {
        const rows = db.prepare('SELECT id, timestamp, message, type FROM job_log ORDER BY id DESC LIMIT 200').all();
        res.json(rows);
    } catch (error) { sendError(res, error); }
});

app.get('/api/overview', (req, res) => {
    try {

        const conflictCleanup = manager.reconcileMissingConflicts(250);
        res.json({
            pipelineRunning: manager.isPipelineRunning(),
            pendingConflicts: db.prepare("SELECT COUNT(*) AS count FROM pending_conflicts WHERE status='pending'").get().count,
            pendingIssues: db.prepare("SELECT COUNT(*) AS count FROM file_issues WHERE status='pending'").get().count,
            recoveryItems: db.prepare("SELECT COUNT(*) AS count FROM recovery_items WHERE status='available'").get().count,
            library: manager.getLibraryOverviewStats(),
            schedule: getSchedulerStatus(),
            reconciledConflictIds: conflictCleanup.removedIds || [],
            databasePath: db.name,
            qcDatabasePath: qcDb.dbPath
        });
    } catch (error) { sendError(res, error); }
});

app.get('/api/ignored-terms/global', (req, res) => {
    try { res.json({ terms: manager.getGlobalIgnoredTerms() }); }
    catch (error) { sendError(res, error); }
});

app.get('/api/ignored-terms/series', (req, res) => {
    const validation = manager.validateSeriesName(req.query.series);
    if (!validation.valid) return sendError(res, new Error(validation.message), 400);
    try { res.json({ series: validation.value, terms: manager.getSeriesIgnoredTerms(validation.value) }); }
    catch (error) { sendError(res, error); }
});

app.put('/api/ignored-terms/global', (req, res) => {
    const terms = req.body?.terms;
    if (!Array.isArray(terms) && typeof terms !== 'string') {
        return sendError(res, new Error('Global ignored chapter terms must be a list of words or phrases.'), 400);
    }
    try {
        const result = manager.setGlobalIgnoredTerms(terms);
        res.json({ success: true, ...result });
    } catch (error) { sendError(res, error, 400); }
});

app.get('/api/settings', (req, res) => {
    try { res.json(parseSettings()); }
    catch (error) { sendError(res, error); }
});

app.get('/api/comicinfo/templates', (req, res) => {
    try { res.json(manager.getComicInfoTemplates()); }
    catch (error) { sendError(res, error); }
});
app.post('/api/comicinfo/templates', (req, res) => {
    try {
        const result = manager.saveComicInfoTemplate(req.body?.series || '', req.body?.xml || '');
        res.json(result);
    } catch (error) { sendError(res, error, 400); }
});
app.get('/api/comicinfo/series', asyncRoute(async (req, res) => res.json(await manager.listComicInfoSeries())));
app.get('/api/comicinfo/archives', asyncRoute(async (req, res) => res.json(await manager.listComicInfoArchives(req.query.series || ''))));
app.get('/api/comicinfo/archive', asyncRoute(async (req, res) => res.json(await manager.getComicInfoArchive(req.query.path || ''))));
app.post('/api/comicinfo/preview', asyncRoute(async (req, res) => res.json(await manager.previewComicInfoTemplateForArchive(req.body?.path || '', req.body?.xml || ''))));
app.put('/api/comicinfo/archive', asyncRoute(async (req, res) => res.json(await manager.saveComicInfoArchive(req.body?.path || '', req.body?.xml || ''))));
app.post('/api/comicinfo/apply', asyncRoute(async (req, res) => res.json(await manager.applyComicInfoPolicyToSeries(req.body?.series || '', req.body?.policy || ''))));
app.get('/api/comicinfo/kavita', asyncRoute(async (req, res) => res.json(await manager.fetchComicInfoKavitaMetadata(req.query.series || ''))));

app.post('/api/settings/schedule', (req, res) => {
    try {
        const preset = String(req.body?.preset || '').trim();
        if (preset === 'off') {
            saveSchedulerState({ schedulePreset: 'off', cronSchedule: '' });
            refreshScheduler();
            manager.log('Automation schedule disabled by user.');
            return res.json({ success: true, preset: 'off', startTime: String(req.body?.startTime || '02:30'), cronSchedule: '', timezone: getSchedulerTimezone() });
        }
        const start = parseScheduleStartTime(req.body?.startTime || '02:30');
        let schedule;
        let effectiveStartTime = start.value;
        if (preset === 'custom') {
            schedule = String(req.body?.customCron || '').trim();
            if (!schedule || !cron.validate(schedule)) throw new Error('Enter a valid custom cron expression. The start-time offset applies to built-in presets, not custom cron.');
            if (cronRunsAtMidnight(schedule)) throw new Error("Custom cron cannot run at exactly 00:00 because that conflicts with Kavita's midnight scan. Choose a different minute or hour.");
        } else {
            effectiveStartTime = normalizeScheduleStartTime(preset, start.value);
            schedule = buildPresetCron(preset, effectiveStartTime);
            if (!cron.validate(schedule)) throw new Error('The selected schedule could not be converted into a valid cron expression.');
            if (cronRunsAtMidnight(schedule)) throw new Error('The selected preset would run at exactly 00:00. Choose another start time.');
        }
        saveSchedulerState({ schedulePreset: preset, scheduleStartTime: effectiveStartTime, cronSchedule: schedule });
        refreshScheduler();
        manager.log(`Automation schedule updated: ${describeCronSchedule(schedule)} (${schedule}, ${getSchedulerTimezone()}).`);
        res.json({ success: true, preset, startTime: effectiveStartTime, cronSchedule: schedule, timezone: getSchedulerTimezone() });
    } catch (error) { sendError(res, error, 400); }
});

const notificationSettingKeys = [
    'notifyPipelineCompleted', 'notifyPipelineFailed', 'notifyPipelineNotRun', 'notifyAttention', 'notifyConflicts', 'notifyQC', 'notifyCompletedChapterMissing',
    'notifyIncludeDuration', 'notifyIncludeFolderSummary', 'notifyIncludeFailureDetails',
    'notifyIncludeMetadata', 'notifyIncludeTimestamp', 'notifyIncludeTestId'
];
const allowedSettings = new Set([
    'sourceRoot', 'destination', 'sourceFolderMode', 'webhookUrl', 'cronSchedule', 'pipelineOrder',
    'autoQC', 'autoQCIntervalHours', 'removeComicInfo', 'comicInfoPolicy', 'comicInfoGlobalTemplate', 'comicInfoSeriesTemplates', 'backupRetentionDays', 'logRetention', 'schedulerTimezone',
    'logFileMaxMB', 'minimumFileAgeSeconds', ...notificationSettingKeys
]);
app.post('/api/settings', (req, res) => {
    try {
        let { key, value } = req.body || {};
        if (!allowedSettings.has(key)) return sendError(res, new Error('Unknown or protected setting.'), 400);
        if (value === undefined || value === null) return sendError(res, new Error('Setting value is required.'), 400);
        if (typeof value === 'object') value = JSON.stringify(value);
        value = String(value).trim();
        if (key === 'cronSchedule' && !cron.validate(value)) return sendError(res, new Error('Invalid cron schedule. Choose one of the listed schedules.'), 400);
        if (key === 'cronSchedule' && cronRunsAtMidnight(value)) return sendError(res, new Error("A cron schedule cannot run at exactly 00:00 because that conflicts with Kavita's midnight scan."), 400);
        if (key === 'sourceFolderMode' && !['auto', 'direct', 'nested'].includes(value)) return sendError(res, new Error('Choose Automatic, direct series folders, or grouped/nested series folders.'), 400);
        if (key === 'comicInfoPolicy' && !['leave', 'update', 'remove', 'replace', 'upgrade'].includes(value)) return sendError(res, new Error('Choose a supported ComicInfo policy.'), 400);
        if (key === 'schedulerTimezone' && value.toLowerCase() !== 'system') {
            try { new Intl.DateTimeFormat('en-US', { timeZone: value }); }
            catch (_) { return sendError(res, new Error('Enter a valid IANA time zone, such as America/New_York, or choose System local time.'), 400); }
        }
        if (['autoQC', 'removeComicInfo', ...notificationSettingKeys].includes(key)) value = value === 'true' || value === '1' ? 'true' : 'false';
        if (key === 'autoQCIntervalHours' && (!Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 720)) {
            return sendError(res, new Error('Automatic QC interval must be from 1 to 720 hours.'), 400);
        }
        if (key === 'backupRetentionDays' && (!Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 365)) {
            return sendError(res, new Error('Recovery retention must be from 1 to 365 days.'), 400);
        }
        if (key === 'logRetention' && (!Number.isFinite(Number(value)) || Number(value) < 500 || Number(value) > 50000)) {
            return sendError(res, new Error('Log retention must be from 500 to 50000 records.'), 400);
        }
        if (key === 'logFileMaxMB' && (!Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 25)) {
            return sendError(res, new Error('Log file limit must be from 1 to 25 MB.'), 400);
        }
        if (key === 'minimumFileAgeSeconds' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 3600)) {
            return sendError(res, new Error('Download stability delay must be from 0 to 3600 seconds.'), 400);
        }
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
        if (key === 'cronSchedule') {
            const inferred = inferSchedulePreset(value);
            saveSchedulerState({ schedulePreset: inferred.preset, scheduleStartTime: inferred.startTime });
        }
        if (key === 'cronSchedule' || key === 'schedulerTimezone') refreshScheduler();
        manager.log(`Settings updated: ${key}.`);
        res.json({ success: true, key, value });
    } catch (error) { sendError(res, error); }
});

app.get('/api/paths/check', asyncRoute(async (req, res) => res.json(await manager.getPathStatus())));
app.get('/api/scan-series', asyncRoute(async (req, res) => res.json(await manager.scanSeries())));
app.get('/api/series/pending-counts', (req, res) => res.json(manager.getSeriesPendingCounts()));

app.get('/api/mappings', (req, res) => {
    try {
        const { sourceRoot, destRoot } = manager.getRoots();
        const rows = db.prepare('SELECT * FROM series_mappings ORDER BY pk_natural_key(target_series), pk_natural_key(source_folder)').all();
        res.json(rows.map(row => {
            const sourcePaths = db.prepare('SELECT id, source_folder, source_path, source_file_count, last_seen FROM series_mapping_sources WHERE mapping_id=? ORDER BY pk_natural_key(source_folder), pk_natural_key(source_path)').all(row.id);
            if (!sourcePaths.length && row.source_path) sourcePaths.push({ id: null, source_folder: row.source_folder, source_path: row.source_path, source_file_count: row.source_file_count, last_seen: row.source_last_seen });
            const sourcePath = row.source_path || (sourceRoot ? path.resolve(sourceRoot, row.source_folder) : '');
            const destinationPath = destRoot ? path.resolve(destRoot, row.target_series) : '';
            let destinationChapterCount = 0;
            try {
                if (destinationPath && fs.existsSync(destinationPath)) {
                    destinationChapterCount = fs.readdirSync(destinationPath, { withFileTypes: true })
                        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz').length;
                }
            } catch (_) {  }
            const normalizedSources = sourcePaths.length ? sourcePaths : (sourcePath ? [{ id: null, source_folder: row.source_folder, source_path: sourcePath, source_file_count: row.source_file_count, last_seen: row.source_last_seen }] : []);
            return {
                ...row,
                volume_mode: manager.getSeriesVolumeMode(row.target_series),
                ignored_terms: manager.getSeriesIgnoredTerms(row.target_series),
                source_paths: normalizedSources.map(item => ({ ...item, exists: Boolean(item.source_path && fs.existsSync(item.source_path)) })),
                source_path: sourcePath,
                destination_path: destinationPath,
                destination_chapter_count: destinationChapterCount,
                source_exists: normalizedSources.some(item => item.source_path && fs.existsSync(item.source_path)) || Boolean(sourcePath && fs.existsSync(sourcePath)),
                destination_exists: Boolean(destinationPath && fs.existsSync(destinationPath))
            };
        }));
    } catch (error) { sendError(res, error); }
});

app.post('/api/mappings', (req, res) => {
    const source = String(req.body?.source || '').trim();
    const sourcePath = String(req.body?.sourcePath || '').trim();
    const sourceFileCount = Math.max(0, Number.parseInt(req.body?.sourceFileCount, 10) || 0);
    const targetResult = manager.validateSeriesName(req.body?.target);
    const volumeModeProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'volumeMode') && req.body.volumeMode !== '' && req.body.volumeMode !== null && req.body.volumeMode !== undefined;
    const volumeMode = volumeModeProvided ? String(req.body.volumeMode) : null;
    const ignoredTermsProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'ignoreTerms');
    if (ignoredTermsProvided && !Array.isArray(req.body.ignoreTerms) && typeof req.body.ignoreTerms !== 'string') return sendError(res, new Error('Ignored chapter terms must be a list of words or phrases.'), 400);
    if (volumeModeProvided && !['off', 'volume-chapters', 'volume-only'].includes(volumeMode)) return sendError(res, new Error('Choose Off, Volumes + Chapters, or Whole Volumes.'), 400);
    if (!source || /[\\/\0]/.test(source)) return sendError(res, new Error('A valid source folder name is required.'), 400);
    const { sourceRoot } = manager.getRoots();
    if (!sourcePath || !sourceRoot || !manager.isWithin(sourceRoot, sourcePath)) return sendError(res, new Error('Choose a specific discovered source path before saving the mapping.'), 400);
    if (!targetResult.valid) return sendError(res, new Error(targetResult.message), 400);
    try {
        const existing = db.prepare('SELECT id, target_series FROM series_mappings WHERE lower(trim(source_folder))=lower(trim(?))').get(source);
        if (existing) {
            if (existing.target_series.trim().toLowerCase() !== targetResult.value.trim().toLowerCase()) {
                return sendError(res, new Error(`A mapping already exists for this source folder name (currently mapped to "${existing.target_series}"). To map a second physical path for the same manga, use the same target series; to change the existing one, edit its mapping.`), 409);
            }
            const alreadyMapped = db.prepare('SELECT mapping_id FROM series_mapping_sources WHERE source_path=?').get(path.resolve(sourcePath));
            if (alreadyMapped && alreadyMapped.mapping_id !== existing.id) return sendError(res, new Error('This physical download path is already assigned to another manga.'), 409);
            db.prepare(`INSERT INTO series_mapping_sources (mapping_id, source_folder, source_path, source_file_count, last_seen)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_path) DO UPDATE SET source_file_count=excluded.source_file_count, last_seen=excluded.last_seen`)
                .run(existing.id, source, path.resolve(sourcePath), sourceFileCount, new Date().toISOString());
            if (volumeModeProvided) manager.setSeriesVolumeMode(targetResult.value, volumeMode);
            if (ignoredTermsProvided) manager.setSeriesIgnoredTerms(targetResult.value, req.body.ignoreTerms);
            manager.log(`Added an additional download path for "${targetResult.value}": ${path.resolve(sourcePath)}`);
            return res.json({ success: true, id: existing.id, sourceAdded: true, volumeMode: manager.getSeriesVolumeMode(targetResult.value), ignoredTerms: manager.getSeriesIgnoredTerms(targetResult.value) });
        }
        const existingPath = db.prepare('SELECT mapping_id FROM series_mapping_sources WHERE source_path=?').get(path.resolve(sourcePath));
        if (existingPath) return sendError(res, new Error('This physical download path is already mapped.'), 409);
        const transaction = db.transaction(() => {
            const result = db.prepare('INSERT INTO series_mappings (source_folder, target_series, active, source_path, source_file_count, source_last_seen) VALUES (?, ?, 1, ?, ?, ?)')
                .run(source, targetResult.value, path.resolve(sourcePath), sourceFileCount, new Date().toISOString());
            const id = Number(result.lastInsertRowid);
            db.prepare('INSERT INTO series_mapping_sources (mapping_id, source_folder, source_path, source_file_count, last_seen) VALUES (?, ?, ?, ?, ?)')
                .run(id, source, path.resolve(sourcePath), sourceFileCount, new Date().toISOString());
            return id;
        });
        const id = transaction();
        if (volumeModeProvided) manager.setSeriesVolumeMode(targetResult.value, volumeMode);
        if (ignoredTermsProvided) manager.setSeriesIgnoredTerms(targetResult.value, req.body.ignoreTerms);
        manager.log(`Created mapping: "${source}" -> "${targetResult.value}" (${path.resolve(sourcePath)})${volumeModeProvided ? ` [${volumeMode}]` : ''}`);
        res.json({ success: true, id, volumeMode: manager.getSeriesVolumeMode(targetResult.value), ignoredTerms: manager.getSeriesIgnoredTerms(targetResult.value) });
    } catch (error) { sendError(res, error, 400); }
});

app.put('/api/mappings/:id', (req, res) => {
    const targetResult = manager.validateSeriesName(req.body?.target);
    if (!targetResult.valid) return sendError(res, new Error(targetResult.message), 400);
    const volumeModeProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'volumeMode') && req.body.volumeMode !== '' && req.body.volumeMode !== null && req.body.volumeMode !== undefined;
    const volumeMode = volumeModeProvided ? String(req.body.volumeMode) : null;
    const ignoredTermsProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'ignoreTerms');
    if (ignoredTermsProvided && !Array.isArray(req.body.ignoreTerms) && typeof req.body.ignoreTerms !== 'string') return sendError(res, new Error('Ignored chapter terms must be a list of words or phrases.'), 400);
    if (volumeModeProvided && !['off', 'volume-chapters', 'volume-only'].includes(volumeMode)) return sendError(res, new Error('Choose Off, Volumes + Chapters, or Whole Volumes.'), 400);
    try {
        const before = db.prepare('SELECT * FROM series_mappings WHERE id=?').get(Number(req.params.id));
        if (!before) return sendError(res, new Error('Mapping not found.'), 404);
        const result = db.prepare('UPDATE series_mappings SET target_series=? WHERE id=?').run(targetResult.value, Number(req.params.id));
        if (!result.changes) return sendError(res, new Error('Mapping not found.'), 404);
        const stillMapped = db.prepare('SELECT 1 FROM series_mappings WHERE lower(target_series)=lower(?) LIMIT 1').get(before.target_series);
        if (!stillMapped) {
            manager.renameSeriesCoverRule(before.target_series, targetResult.value);
            manager.renameSeriesVolumeMode(before.target_series, targetResult.value);
            manager.renameSeriesIgnoredTerms(before.target_series, targetResult.value);
        }
        if (volumeModeProvided) manager.setSeriesVolumeMode(targetResult.value, volumeMode);
        if (ignoredTermsProvided) manager.setSeriesIgnoredTerms(targetResult.value, req.body.ignoreTerms);
        manager.log(`Updated mapping #${req.params.id} to "${targetResult.value}"${volumeModeProvided ? ` (volume mode: ${volumeMode})` : ''}.`);
        res.json({ success: true, volumeMode: manager.getSeriesVolumeMode(targetResult.value), ignoredTerms: manager.getSeriesIgnoredTerms(targetResult.value) });
    } catch (error) { sendError(res, error, 400); }
});

app.delete('/api/mappings/:id/sources/:sourceId', (req, res) => {
    try {
        const mappingId = Number(req.params.id);
        const sourceId = Number(req.params.sourceId);
        const row = db.prepare('SELECT * FROM series_mapping_sources WHERE id=? AND mapping_id=?').get(sourceId, mappingId);
        if (!row) return sendError(res, new Error('Mapped source path not found.'), 404);
        const mapping = db.prepare('SELECT * FROM series_mappings WHERE id=?').get(mappingId);
        const transaction = db.transaction(() => {
            db.prepare('DELETE FROM series_mapping_sources WHERE id=?').run(sourceId);
            if (mapping?.source_path && (process.platform === 'win32' ? path.resolve(mapping.source_path).toLowerCase() === path.resolve(row.source_path).toLowerCase() : path.resolve(mapping.source_path) === path.resolve(row.source_path))) {
                const replacement = db.prepare('SELECT source_path, source_file_count FROM series_mapping_sources WHERE mapping_id=? ORDER BY id LIMIT 1').get(mappingId);
                db.prepare('UPDATE series_mappings SET source_path=?, source_file_count=?, source_last_seen=? WHERE id=?')
                    .run(replacement?.source_path || '', replacement?.source_file_count || 0, replacement ? new Date().toISOString() : null, mappingId);
            }
        });
        transaction();
        manager.log(`Removed one source path from mapping #${mappingId}: ${row.source_path}`);
        res.json({ success: true });
    } catch (error) { sendError(res, error); }
});

app.delete('/api/mappings/:id', (req, res) => {
    try {
        const result = db.prepare('DELETE FROM series_mappings WHERE id=?').run(Number(req.params.id));
        if (!result.changes) return sendError(res, new Error('Mapping not found.'), 404);
        manager.log(`Deleted mapping #${req.params.id}.`);
        res.json({ success: true });
    } catch (error) { sendError(res, error); }
});

app.get('/api/conflicts/filters', (req, res) => {
    try {
        const series = db.prepare("SELECT target_series AS name, COUNT(*) AS count FROM pending_conflicts WHERE status='pending' GROUP BY target_series ORDER BY pk_natural_key(target_series)").all();
        res.json({ series });
    } catch (error) { sendError(res, error); }
});

app.get('/api/conflicts', asyncRoute(async (req, res) => {
    try {
        await manager.reconcileQueuedChapterItems();
        manager.reconcileMissingConflicts(5000);
        const { page, limit, offset } = getPagination(req);
        const search = String(req.query.search ?? '').slice(0, 200);
        const series = String(req.query.series || '').trim().slice(0, 200);
        const conditions = ["status='pending'"];
        const params = [];
        if (series) { conditions.push('target_series = ?'); params.push(series); }
        addPatternSearch(conditions, params, search, ['target_series', 'chapter_label', 'source_path', 'destination_path']);
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS count FROM pending_conflicts WHERE ${where}`).get(...params).count;
        const conflicts = db.prepare(`SELECT * FROM pending_conflicts WHERE ${where} ORDER BY pk_natural_key(target_series), pk_natural_key(chapter_label), id DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        res.json({ items: conflicts.map(item => ({
            ...item,
            ...manager.getConflictProposal(item),
            source_exists: manager.getPathPresence(item.source_path),
            destination_exists: manager.getPathPresence(item.destination_path),
            source_basename: path.basename(item.source_path),
            destination_basename: path.basename(item.destination_path)
        })), total, page, limit, search, series });
    } catch (error) { sendError(res, error); }
}));

app.post('/api/conflicts/bulk-resolve', asyncRoute(async (req, res) => {
    const action = String(req.body?.action || '');
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let selectedIds = ids;
    if (req.body?.allFiltered === true) {
        const search = String(req.body?.search ?? '').slice(0, 200);
        const series = String(req.body?.series || '').trim().slice(0, 200);
        const conditions = ["status='pending'"];
        const params = [];
        if (series) { conditions.push('target_series = ?'); params.push(series); }
        addPatternSearch(conditions, params, search, ['target_series', 'chapter_label', 'source_path', 'destination_path']);
        selectedIds = db.prepare(`SELECT id FROM pending_conflicts WHERE ${conditions.join(' AND ')} ORDER BY id`)
            .all(...params).map(row => row.id);
        if (selectedIds.length > 5000) return sendError(res, new Error('Bulk actions are limited to 5,000 conflicts at a time. Narrow the filters and run another batch.'), 413);
    }
    if (!selectedIds.length) return sendError(res, new Error('No pending conflicts were selected.'), 400);
    const result = await manager.resolveConflictsBulk(selectedIds, action);
    res.json(result);
}));

app.delete('/api/conflicts/:id', asyncRoute(async (req, res) => {
    res.json(manager.removeStaleConflict(req.params.id));
}));

app.get('/api/conflicts/:id/compare', asyncRoute(async (req, res) => {
    const conflict = db.prepare("SELECT * FROM pending_conflicts WHERE id=? AND status='pending'").get(Number(req.params.id));
    if (!conflict) return sendError(res, new Error('Pending conflict not found.'), 404);
    const [sourceDirectory, libraryDirectory] = await Promise.all([
        manager.zip.readZipDirectory(conflict.source_path),
        manager.zip.readZipDirectory(conflict.destination_path)
    ]);
    const sourcePages = manager.zip.imageEntries(sourceDirectory).map((entry, index) => ({ index, name: entry.name, size: entry.uncompressedSize }));
    const libraryPages = manager.zip.imageEntries(libraryDirectory).map((entry, index) => ({ index, name: entry.name, size: entry.uncompressedSize }));
    res.json({
        conflict: {
            id: conflict.id,
            target_series: conflict.target_series,
            chapter_label: conflict.chapter_label,
            source_name: path.basename(conflict.source_path),
            destination_name: path.basename(conflict.destination_path),
            source_size: conflict.source_size,
            destination_size: conflict.destination_size
        },
        sourcePages,
        libraryPages,
        note: 'Page counts and byte sizes are informational only; different sources can split the same complete chapter into different numbers of images.'
    });
}));

app.get('/api/conflicts/:id/page/:side/:index', async (req, res) => {
    try {
        const conflict = db.prepare("SELECT * FROM pending_conflicts WHERE id=? AND status='pending'").get(Number(req.params.id));
        if (!conflict) return res.status(404).end('Pending conflict not found.');
        const side = req.params.side;
        if (side !== 'source' && side !== 'library') return res.status(400).end('Invalid comparison side.');
        const filePath = side === 'source' ? conflict.source_path : conflict.destination_path;
        if (!fs.existsSync(filePath)) return res.status(404).end('Comparison file no longer exists.');
        const directory = await manager.zip.readZipDirectory(filePath);
        const pages = manager.zip.imageEntries(directory);
        const index = Number(req.params.index);
        if (!Number.isInteger(index) || index < 0 || index >= pages.length) return res.status(404).end('Page not found.');
        const entry = pages[index];
        const stream = await manager.zip.createEntryReadStream(filePath, entry);
        res.setHeader('Content-Type', manager.zip.mimeTypeForImage(entry.name));
        res.setHeader('Content-Length', String(entry.uncompressedSize));
        res.setHeader('Cache-Control', 'private, max-age=3600');
        stream.on('error', error => {
            manager.log(`Comparison preview failed for ${path.basename(filePath)} (${entry.name}): ${error.message}`, 'WARN');
            if (!res.headersSent) res.status(500);
            res.destroy(error);
        });
        stream.pipe(res);
    } catch (error) {
        if (!res.headersSent) res.status(error.code === 'ZIP_FORMAT_ERROR' ? 422 : 500).end(error.message);
        else res.destroy(error);
    }
});

app.post('/api/conflicts/:id/resolve', asyncRoute(async (req, res) => {
    const action = String(req.body?.action || '');
    res.json(await manager.resolveConflict(req.params.id, action));
}));

app.get('/api/issues/:id/pages', asyncRoute(async (req, res) => res.json(await manager.getIssueArchivePages(req.params.id))));
app.get('/api/issues/:id/pages/:index', asyncRoute(async (req, res) => streamArchiveEntry(res, await manager.getIssueArchivePage(req.params.id, req.params.index))));
app.delete('/api/issues/:id/pages/:entryIndex', asyncRoute(async (req, res) => res.json(await manager.deleteIssueArchivePage(req.params.id, req.params.entryIndex))));
app.post('/api/issues/:id/pages/reorder', asyncRoute(async (req, res) => res.json(await manager.reorderIssueArchivePages(req.params.id, req.body?.entryOrder))));

app.get('/api/issues/filters', (req, res) => {
    try { res.json({ series: manager.getIssueSeriesFilters() }); }
    catch (error) { sendError(res, error); }
});

app.get('/api/issues', asyncRoute(async (req, res) => {
    try {
        await manager.reconcileQueuedChapterItems();
        const { page, limit, offset } = getPagination(req);
        const search = String(req.query.search ?? '').slice(0, 200);
        const series = String(req.query.series || '').trim().slice(0, 200);
        const conditions = ["status='pending'"];
        const params = [];
        if (series === '__unmapped__') conditions.push("(target_series IS NULL OR target_series='')");
        else if (series) { conditions.push('target_series = ?'); params.push(series); }
        addPatternSearch(conditions, params, search, ['path', 'kind', 'reason', 'target_series']);
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS count FROM file_issues WHERE ${where}`).get(...params).count;
        const rows = db.prepare(`SELECT * FROM file_issues WHERE ${where} ORDER BY pk_natural_key(target_series), pk_natural_key(path), updated_at DESC, id DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        res.json({ items: rows.map(row => ({
            ...row,
            ...manager.getIssueProposal(row),
            basename: path.basename(row.path),
            exists: fs.existsSync(row.path)
        })), total, page, limit, search, series });
    } catch (error) { sendError(res, error); }
}));

app.get('/api/issues/:id/proposal', (req, res) => {
    try {
        res.json(manager.previewIssueProposal(req.params.id, req.query.chapter || ''));
    } catch (error) { sendError(res, error, error.message === 'Pending Attention item not found.' ? 404 : 400); }
});

app.delete('/api/issues/:id', asyncRoute(async (req, res) => {
    res.json(await manager.deleteFileIssue(req.params.id));
}));

app.post('/api/issues/:id/set-chapter', asyncRoute(async (req, res) => {
    const result = await manager.setManualChapterForIssue(req.params.id, req.body?.chapter);
    res.status(202).json(result);
}));

app.post('/api/issues/bulk/set-chapters', asyncRoute(async (req, res) => {
    const result = await manager.setManualChaptersForIssues(req.body?.items);
    res.status(202).json(result);
}));

app.post('/api/issues/:id/ignore', (req, res) => {
    try {
        const result = db.prepare("UPDATE file_issues SET status='ignored', updated_at=? WHERE id=? AND status='pending'")
            .run(new Date().toISOString(), Number(req.params.id));
        if (!result.changes) return sendError(res, new Error('Pending issue not found.'), 404);
        manager.log(`Ignored review item #${req.params.id} at the user's request.`, 'WARN');
        res.json({ success: true });
    } catch (error) { sendError(res, error); }
});

async function recheckIssueRecord(issueId) {
    const issue = db.prepare("SELECT * FROM file_issues WHERE id=? AND status='pending'").get(Number(issueId));
    if (!issue) throw new Error('Pending issue not found.');
    if (!(await fs.pathExists(issue.path))) {
        db.prepare("UPDATE file_issues SET status='resolved', updated_at=? WHERE id=?").run(new Date().toISOString(), issue.id);
        return { success: true, resolved: true, message: 'File no longer exists at the recorded path.' };
    }
    try {
        await manager.zip.readZipDirectory(issue.path);
        if (issue.kind === 'xml_cleanup_failed') {
            try {
                const result = await manager.applyComicInfoPolicyToReviewFile(issue.path, issue.target_series || '');
                db.prepare("UPDATE file_issues SET status='resolved', updated_at=?, reason=? WHERE id=?")
                    .run(new Date().toISOString(), `Resolved by the saved ComicInfo ${result.policy} policy. ${result.message}`, issue.id);
                manager.log(`ComicInfo ${result.policy} policy recheck succeeded for ${path.basename(issue.path)}.`);
                return { success: true, resolved: true, policy: result.policy, changed: Boolean(result.changed), message: result.message };
            } catch (error) {
                const reason = `The saved ComicInfo policy could not be applied to this file: ${error.message}`;
                db.prepare('UPDATE file_issues SET updated_at=?, reason=? WHERE id=?')
                    .run(new Date().toISOString(), reason, issue.id);
                manager.log(`ComicInfo policy recheck failed for ${path.basename(issue.path)}: ${error.message}`, 'ERROR');
                return { success: true, resolved: false, message: reason };
            }
        }
        if (issue.kind === 'bad_archive') {
            db.prepare("UPDATE file_issues SET status='resolved', updated_at=? WHERE id=?").run(new Date().toISOString(), issue.id);
            manager.log(`Archive now reads successfully: ${path.basename(issue.path)}.`, 'INFO');
            if (!manager.isPipelineRunning()) {
                manager.runPipeline().catch(error => manager.log(`Recheck pipeline failed: ${error.message}`, 'ERROR'));
                return { success: true, resolved: true, message: 'Archive now reads successfully. Processing has been started.' };
            }
            return { success: true, resolved: true, message: 'Archive now reads successfully. The current pipeline is already running.' };
        }
        if (issue.kind === 'unsupported_archive') {
            db.prepare("UPDATE file_issues SET status='resolved', updated_at=?, reason=? WHERE id=?")
                .run(new Date().toISOString(), 'Archive now opens with the supported metadata reader; it may have been replaced or repaired.', issue.id);
            manager.log(`Archive is now readable by PanelKeeper: ${path.basename(issue.path)}.`);
            if (!manager.isPipelineRunning()) {
                manager.runPipeline().catch(error => manager.log(`Recheck pipeline failed: ${error.message}`, 'ERROR'));
                return { success: true, resolved: true, message: 'Archive is now readable. Processing has been started.' };
            }
            return { success: true, resolved: true, message: 'Archive is now readable. The running pipeline will pick it up.' };
        }
        db.prepare('UPDATE file_issues SET updated_at=?, reason=? WHERE id=?')
            .run(new Date().toISOString(), `Archive is structurally readable. ${issue.kind === 'unparsed_chapter' ? 'Assign a chapter in this queue or correct the source mapping.' : 'Re-run processing after resolving any access or download issue.'}`, issue.id);
        if (!manager.isPipelineRunning() && ['move_failed', 'destination_access'].includes(issue.kind)) {
            manager.runPipeline().catch(error => manager.log(`Recheck pipeline failed: ${error.message}`, 'ERROR'));
            return { success: true, resolved: false, message: 'Archive is readable. Processing was retried; refresh the queue if the issue remains.' };
        }
        return { success: true, resolved: false, message: issue.kind === 'unparsed_chapter' ? 'The archive is readable, but its chapter could not be identified. Use Set Chapter & Process on this item.' : 'The archive is readable; the item still needs a pipeline pass or a path/permission correction.' };
    } catch (error) {
        const kind = ['ZIP64_UNSUPPORTED', 'MULTIDISK_UNSUPPORTED', 'ZIP_DIRECTORY_TOO_LARGE'].includes(error.code) ? 'unsupported_archive' : 'bad_archive';
        db.prepare('UPDATE file_issues SET kind=?, updated_at=?, reason=? WHERE id=?').run(kind, new Date().toISOString(), error.message, issue.id);
        return { success: true, resolved: false, message: `Still not safely processable: ${error.message}` };
    }
}

app.post('/api/issues/:id/recheck', asyncRoute(async (req, res) => {
    res.json(await recheckIssueRecord(req.params.id));
}));

app.post('/api/issues/bulk', asyncRoute(async (req, res) => {
    const action = String(req.body?.action || '');
    if (!['recheck', 'dismiss', 'delete'].includes(action)) throw new Error('Choose Recheck, Dismiss, or Delete Files.');
    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isSafeInteger) : [];
    if (req.body?.allFiltered === true) {
        const search = String(req.body?.search ?? '').slice(0, 200);
        const series = String(req.body?.series || '').slice(0, 200);
        const conditions = ["status='pending'"];
        const params = [];
        if (series === '__unmapped__') conditions.push("(target_series IS NULL OR target_series='')");
        else if (series) { conditions.push('target_series = ?'); params.push(series); }
        addPatternSearch(conditions, params, search, ['path', 'kind', 'reason', 'target_series']);
        ids = db.prepare(`SELECT id FROM file_issues WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 5001`).all(...params).map(row => row.id);
        if (ids.length > 5000) return sendError(res, new Error('Bulk Attention actions are limited to 5,000 items at a time. Narrow the filters and run another batch.'), 413);
    }
    ids = [...new Set(ids)];
    if (ids.length > 5000) return sendError(res, new Error('Bulk Attention actions are limited to 5,000 selected records at a time. Use Apply to all filtered results or narrow the filter and repeat.'), 413);
    if (!ids.length) throw new Error('No pending Attention records were selected.');
    const completed = [];
    const failed = [];
    let processedCount = 0;
    for (const id of ids) {
        try {
            const issue = db.prepare("SELECT id FROM file_issues WHERE id=? AND status='pending'").get(id);
            if (!issue) throw new Error('Record is no longer pending.');
            if (action === 'recheck') {
                const result = await recheckIssueRecord(id);
                completed.push({ id, ...result });
            } else if (action === 'dismiss') {
                const update = db.prepare("UPDATE file_issues SET status='ignored', updated_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(), id);
                if (!update.changes) throw new Error('Record is no longer pending.');
                manager.log(`Dismissed Attention item #${id} in a bulk action.`, 'WARN');
                completed.push({ id, success: true, message: 'Record dismissed; file unchanged.' });
            } else {
                const result = await manager.deleteFileIssue(id);
                completed.push({ id, ...result });
            }
        } catch (error) { failed.push({ id, error: error.message }); }
        processedCount++;
        if (processedCount % 20 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    res.json({ success: failed.length === 0, action, completed: completed.length, failed, results: completed });
}));
app.get('/api/recovery/filters', (req, res) => {
    try {
        const series = db.prepare("SELECT series AS name, COUNT(*) AS count FROM recovery_items WHERE status='available' GROUP BY series ORDER BY pk_natural_key(series)").all();
        res.json({ series });
    } catch (error) { sendError(res, error); }
});

app.get('/api/recovery', (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req);
        const search = String(req.query.search ?? '').slice(0, 200);
        const series = String(req.query.series || '').trim().slice(0, 200);
        const conditions = ["status='available'"];
        const params = [];
        if (series) { conditions.push('series = ?'); params.push(series); }
        addPatternSearch(conditions, params, search, ['series', 'original_path', 'backup_path']);
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS count FROM recovery_items WHERE ${where}`).get(...params).count;
        const rows = db.prepare(`SELECT * FROM recovery_items WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        res.json({ items: rows.map(row => ({ ...row, basename: path.basename(row.backup_path), original_basename: path.basename(row.original_path), exists: manager.getPathPresence(row.backup_path) })), total, page, limit, search, series });
    } catch (error) { sendError(res, error); }
});
app.get('/api/recovery/:id/pages', asyncRoute(async (req, res) => res.json(await manager.getRecoveryArchivePages(req.params.id))));
app.get('/api/recovery/:id/pages/:index', asyncRoute(async (req, res) => streamArchiveEntry(res, await manager.getRecoveryArchivePage(req.params.id, req.params.index))));
app.delete('/api/recovery/:id/pages/:entryIndex', asyncRoute(async (req, res) => res.json(await manager.deleteRecoveryArchivePage(req.params.id, req.params.entryIndex))));
app.post('/api/recovery/:id/pages/reorder', asyncRoute(async (req, res) => res.json(await manager.reorderRecoveryArchivePages(req.params.id, req.body?.entryOrder))));
app.post('/api/recovery/:id/restore', asyncRoute(async (req, res) => res.json(await manager.restoreRecoveryItem(req.params.id))));
app.delete('/api/recovery/:id', asyncRoute(async (req, res) => res.json(await manager.deleteRecoveryItem(req.params.id))));
app.post('/api/recovery/bulk', asyncRoute(async (req, res) => {
    const action = String(req.body?.action || '');
    let ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (req.body?.allFiltered === true) {
        const search = String(req.body?.search ?? '').slice(0, 200);
        const series = String(req.body?.series || '').trim().slice(0, 200);
        const conditions = ["status='available'"];
        const params = [];
        if (series) { conditions.push('series = ?'); params.push(series); }
        addPatternSearch(conditions, params, search, ['series', 'original_path', 'backup_path']);
        ids = db.prepare(`SELECT id FROM recovery_items WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT 5001`).all(...params).map(row => row.id);
        if (ids.length > 5000) return sendError(res, new Error('Bulk Recovery actions are limited to 5,000 items at a time. Narrow the filters and run another batch.'), 413);
    }
    res.json(await manager.bulkRecoveryAction(ids, action));
}));

app.get('/api/qc/filters', (req, res) => {
    try { res.json({ series: manager.getQcSeriesFilters() }); }
    catch (error) { sendError(res, error); }
});

app.get('/api/qc/status', (req, res) => {
    try { res.json(manager.getLatestQcScanStatus()); }
    catch (error) { sendError(res, error); }
});

app.get('/api/qc/scan', (req, res) => {
    try {
        res.json(manager.startQcScan({ reason: 'manual QC scan', autoFix: false, useCache: true }));
    } catch (error) { sendError(res, error); }
});

app.get('/api/qc/scan/:jobId', (req, res) => {
    const job = manager.getQcScanStatus(req.params.jobId);
    if (!job) return sendError(res, new Error('QC job not found. Start a new scan.'), 404);
    res.json(job);
});

app.get('/api/qc/results', (req, res) => {
    try {
        res.json(manager.getQcResults({ page: req.query.page, limit: req.query.limit, search: req.query.search, series: req.query.series, issue: req.query.issue }));
    } catch (error) { sendError(res, error); }
});

app.post('/api/qc/dismiss', (req, res) => {
    try { res.json(manager.dismissQcIssue(req.body?.path)); }
    catch (error) { sendError(res, error, 400); }
});
app.post('/api/qc/dismiss/bulk', (req, res) => {
    try { res.json(manager.dismissQcIssues(req.body?.paths)); }
    catch (error) { sendError(res, error, 400); }
});

app.post('/api/qc/fix', asyncRoute(async (req, res) => {
    const result = await manager.fixLibraryIssues(req.body?.files);
    res.json({ success: true, ...result });
}));

app.get('/api/library/series', asyncRoute(async (req, res) => res.json(await manager.listLibrarySeries())));
app.post('/api/library/scan', (req, res) => {
    try { res.status(202).json({ success: true, job: manager.startLibraryCatalogScan('manual library inventory refresh') }); }
    catch (error) { sendError(res, error, 400); }
});
app.get('/api/library/scan/status', (req, res) => res.json(manager.catalogJobStatus()));
app.get('/api/library/series/:series', asyncRoute(async (req, res) => {
    const { page, limit } = getPagination(req);
    res.json(await manager.getLibrarySeriesDetail(req.params.series, { page, limit, kind: req.query.kind || 'all' }));
}));
app.post('/api/library/series/:series/metadata', asyncRoute(async (req, res) => {
    try {

        if (req.body?.completed === true) {
            await manager.refreshLibrarySeriesForCompletion(req.params.series);
        }
        const result = manager.setLibrarySeriesMetadata(req.params.series, {
            completed: req.body?.completed,
            notes: req.body?.notes,
            volumeMode: req.body?.volumeMode
        });
        res.json(result);
    } catch (error) { sendError(res, error, 400); }
}));
app.post('/api/library/series/:series/rename', asyncRoute(async (req, res) => {
    const result = await manager.renameLibrarySeries(req.params.series, req.body?.newName);
    res.json(result);
}));
app.post('/api/library/series/:series/delete-chapters', asyncRoute(async (req, res) => {
    const result = await manager.deleteLibraryChaptersToRecovery(req.params.series, req.body?.range);
    res.json(result);
}));
app.post('/api/library/series/:series/rename-chapter', asyncRoute(async (req, res) => {
    const result = await manager.renameLibraryChapter(req.params.series, req.body?.path, req.body?.chapter);
    res.json(result);
}));

app.get('/api/library/archive/pages', asyncRoute(async (req, res) => {
    res.json(await manager.getLibraryArchivePages(req.query.path, req.query.series || ''));
}));
app.get('/api/library/archive/page', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    await streamArchiveEntry(res, await manager.getLibraryArchivePage(req.query.path, req.query.index));
}));
app.delete('/api/library/archive/page', asyncRoute(async (req, res) => {
    res.json(await manager.deleteLibraryArchivePage(req.query.path, req.query.entryIndex));
}));
app.post('/api/library/archive/reorder', asyncRoute(async (req, res) => {
    res.json(await manager.reorderLibraryArchivePages(req.body?.path, req.body?.entryOrder));
}));

app.get('/api/covers/series', asyncRoute(async (req, res) => res.json(await manager.listCoverSeries())));
app.post('/api/covers/bulk', (req, res) => {
    try {
        const job = manager.startKavitaAutoCoverBulkJob(req.body?.series, req.body?.action);
        res.status(202).json({ success: true, job });
    } catch (error) { sendError(res, error, 400); }
});
app.get('/api/covers/bulk/jobs/:id', (req, res) => {
    const job = manager.getKavitaAutoCoverBulkJob(req.params.id);
    if (!job) return sendError(res, new Error('Bulk cover job not found.'), 404);
    res.json(job);
});
app.post('/api/covers/bulk/jobs/:id/cancel', (req, res) => {
    try { res.json(manager.cancelKavitaAutoCoverBulkJob(req.params.id)); }
    catch (error) { sendError(res, error, 400); }
});
app.get('/api/covers/kavita/connection', (req, res) => {
    res.json(manager.getKavitaConnectionStatus());
});
app.post('/api/covers/kavita/connection', asyncRoute(async (req, res) => {
    const status = await manager.saveKavitaConnection({ baseUrl: req.body?.baseUrl, apiKey: req.body?.apiKey });
    res.json({ success: true, connection: status });
}));
app.get('/api/covers/kavita/settings', asyncRoute(async (req, res) => {
    try { res.json(await manager.getKavitaCoverSettings(req.query.series)); }
    catch (error) { sendError(res, error, 400); }
}));
app.get('/api/covers/kavita/search', asyncRoute(async (req, res) => {
    res.json(await manager.searchKavitaSeries(req.query.q || ''));
}));
app.get('/api/covers/kavita/match', asyncRoute(async (req, res) => {
    res.json(await manager.findKavitaSeriesMatch(req.query.series || ''));
}));
app.get('/api/covers/kavita/preview', asyncRoute(async (req, res) => {
    const image = await manager.getKavitaSeriesCoverPreview(req.query.seriesId);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', String(image.length));
    res.send(image);
}));
app.post('/api/covers/save', asyncRoute(async (req, res) => {
    try {
        const result = await manager.saveChapterCoverSettings(req.body?.series, req.body || {});
        res.status(202).json(result);
    } catch (error) {
        if (error?.code === 'KAVITA_MATCH_REQUIRED') {
            return res.status(409).json({ error: error.message, code: error.code, details: error.details || null });
        }
        sendError(res, error, 400);
    }
}));
app.post('/api/covers/kavita/download', asyncRoute(async (req, res) => {
    const result = await manager.downloadKavitaMainCover(
        req.body?.series, req.body?.kavitaSeriesId, req.body?.kavitaSeriesName || '', req.body?.overwriteExisting === true
    );
    res.json(result);
}));
app.post('/api/covers/kavita/source', asyncRoute(async (req, res) => {
    const result = await manager.saveKavitaSeriesCoverSource(
        req.body?.series, req.body?.enabled === true, req.body?.kavitaSeriesId, req.body?.kavitaSeriesName || ''
    );
    res.json(result);
}));
app.post('/api/covers/kavita/auto-cover', asyncRoute(async (req, res) => {
    const result = await manager.setKavitaAutoCover(
        req.body?.series,
        req.body?.enabled === true,
        req.body?.refresh === true
    );
    res.status(202).json(result);
}));
app.get('/api/covers/preview', asyncRoute(async (req, res) => res.json(await manager.getCoverPreview(req.query.series, req.query.chapter || '', req.query.coverPath || '', req.query.preferred === '1'))));
app.get('/api/covers/preview-image', asyncRoute(async (req, res) => {
    const series = String(req.query.series || '');
    const kind = String(req.query.kind || 'cover');
    if (kind === 'cover') {
        const coverPath = await manager.getCoverPreviewCandidate(series, String(req.query.file || ''));
        return res.type(path.extname(coverPath)).sendFile(coverPath);
    }
    if (kind === 'chapter') {
        const page = await manager.getCoverPreviewPage(series, String(req.query.chapter || ''), req.query.index);
        res.setHeader('Content-Type', page.mimeType);
        res.setHeader('Cache-Control', 'no-store');
        const stream = await manager.zip.createEntryReadStream(page.archivePath, page.entry);
        stream.on('error', error => {
            if (!res.headersSent) sendError(res, error);
            else res.destroy(error);
        });
        return stream.pipe(res);
    }
    return sendError(res, new Error('Unknown cover preview type.'), 400);
}));
const coverUploadContentTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/tiff', 'image/x-tiff', 'application/octet-stream'];
app.post('/api/covers/import', express.raw({ type: coverUploadContentTypes, limit: '40mb' }), asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return sendError(res, new Error('Choose a supported image file before importing.'), 400);
    }
    const result = await manager.importSeriesCoverImage(
        req.query.series,
        req.query.filename || req.headers['x-file-name'] || 'cover',
        req.headers['content-type'],
        req.body
    );
    res.status(201).json(result);
}));

app.post('/api/covers/rule', (req, res) => {
    try {
        const job = manager.startCoverUpdateJob(req.body?.series, req.body?.enabled === true, req.body?.coverPath || '');
        res.status(202).json({ success: true, job });
    } catch (error) { sendError(res, error, 400); }
});
app.get('/api/covers/jobs/:id', (req, res) => {
    const job = manager.getCoverJobStatus(req.params.id);
    if (!job) return sendError(res, new Error('Cover update job not found.'), 404);
    res.json(job);
});
app.get('/api/covers/jobs/latest', (req, res) => res.json(manager.getLatestCoverJob(req.query.series) || null));

app.get('/api/covers/design', (req, res) => {
    const series = String(req.query.series || '');
    res.json({
        design: manager.getChapterCoverDesign(series),
        job: manager.getLatestChapterCoverJob(series)
    });
});
app.get('/api/covers/design/preview', asyncRoute(async (req, res) => {
    const design = {
        template: String(req.query.template || 'Chapter {number}'),
        position: String(req.query.position || 'top-center'),
        fontSize: Number(req.query.fontSize || 6),
        textColor: String(req.query.textColor || '#ffffff'),
        outlineColor: String(req.query.outlineColor || '#000000'),
        outlineWidth: Number(req.query.outlineWidth ?? 3),
        panelEnabled: String(req.query.panelEnabled || 'false') === 'true',
        panelColor: String(req.query.panelColor || '#000000'),
        panelOpacity: Number(req.query.panelOpacity ?? 0.48)
    };
    const buffer = await manager.getChapterCoverDesignPreview(
        req.query.series,
        req.query.chapter,
        req.query.coverPath,
        design
    );
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
}));
app.post('/api/covers/design', (req, res) => {
    try {
        const result = manager.saveChapterCoverDesign(
            req.body?.series,
            req.body?.enabled === true,
            req.body?.coverPath || '',
            req.body?.design || {}
        );
        res.status(202).json({ success: true, ...result });
    } catch (error) { sendError(res, error, 400); }
});
app.get('/api/covers/design/jobs/latest', (req, res) => {
    res.json(manager.getLatestChapterCoverJob(req.query.series) || null);
});
app.get('/api/covers/design/jobs/:id', (req, res) => {
    const job = manager.getChapterCoverJobStatus(req.params.id);
    if (!job) return sendError(res, new Error('Generated chapter-cover job not found.'), 404);
    res.json(job);
});

app.post('/api/test-notify', asyncRoute(async (req, res) => {
    const testedAt = new Date().toLocaleString('en-US', { timeZone: getSchedulerTimezone(), timeZoneName: 'short' });
    const result = await manager.sendNotification(`PanelKeeper Home Assistant webhook test (${testedAt}).`, { event: 'test' });
    if (!result.sent) {
        manager.log(`Home Assistant webhook test failed${result.host ? ` for ${result.host}` : ''}: ${result.reason || 'Unknown webhook error'}`, 'ERROR');
        return sendError(res, new Error(result.reason || 'Webhook test failed.'), 502);
    }
    manager.log(`Home Assistant webhook endpoint returned HTTP ${result.status} from ${result.host}; test ID ${result.testId}. HTTP success does not prove the webhook ID matched an active automation or that the automation ran.`);
    const payloadFields = Object.keys(result.payload || {}).map(key => `trigger.json.${key}`);
    res.json({
        success: true,
        httpResponded: true,
        automationConfirmed: false,
        testId: result.testId,
        payloadFields,
        message: `PanelKeeper received an HTTP ${result.status} response from ${result.host}; this confirms network-level HTTP response only, NOT that Home Assistant ran an automation. Home Assistant intentionally returns the same response for unknown webhook IDs, and may return HTTP 200 when a local_only webhook ignores a request from a remote network. Check that the webhook ID exactly matches the ID in one enabled automation, that POST is allowed, and that local_only is disabled only when PanelKeeper reaches HA over a remote/VPN network. Then inspect that automation's Traces. This request included: ${payloadFields.join(', ')}. The message field is always included; optional metadata fields are controlled by Settings. To see a notification in HA, the automation also needs an action such as persistent_notification.create or a mobile notify action.`
    });
}));

app.post('/api/run', asyncRoute(async (req, res) => {
    if (manager.isPipelineRunning()) return sendError(res, new Error('The pipeline is already running. New requests are safely skipped to prevent overlapping file moves.'), 409);
    const startedAt = new Date().toISOString();
    saveSchedulerState({
        lastPipelineRunAt: startedAt,
        lastPipelineFinishedAt: '',
        lastPipelineElapsedSeconds: '',
        lastPipelineTrigger: 'manual',
        lastPipelineStatus: 'running',
        lastPipelineMessage: 'Manual pipeline run is running.'
    });
    res.status(202).json({ success: true, message: 'Pipeline started. Track progress in the Overview status and System Logs.' });
    manager.runPipeline().then(result => {
        const finishedAt = new Date().toISOString();
        const success = result?.success !== false;
        const message = success ? `Completed in ${Number(result?.elapsedSeconds || 0)} second(s).` : `Stopped without completing: ${result?.reason || 'pipeline returned an unsuccessful result'}.`;
        const elapsed = Number.isFinite(Number(result?.elapsedSeconds)) && result?.elapsedSeconds !== undefined
            ? Math.max(0, Number(result.elapsedSeconds))
            : (elapsedSecondsBetween(startedAt, finishedAt) ?? 0);
        saveSchedulerState({ lastPipelineFinishedAt: finishedAt, lastPipelineElapsedSeconds: elapsed, lastPipelineStatus: success ? 'completed' : 'failed', lastPipelineMessage: message });
    }).catch(error => {
        const finishedAt = new Date().toISOString();
        const elapsed = elapsedSecondsBetween(startedAt, finishedAt) ?? 0;
        saveSchedulerState({ lastPipelineFinishedAt: finishedAt, lastPipelineElapsedSeconds: elapsed, lastPipelineStatus: 'failed', lastPipelineMessage: error.message });
        manager.log(`Pipeline request failed: ${error.message}`, 'ERROR');
    });
}));

app.use((error, req, res, next) => {
    manager.log(`API error (${req.method} ${req.path}): ${error.stack || error.message}`, 'ERROR');
    if (res.headersSent) return next(error);
    sendError(res, error, error.statusCode || 500);
});

const server = app.listen(PORT, () => {
    manager.log(`PanelKeeper is running at http://localhost:${PORT}`);
    manager.log(`Project directory: ${APP_DIR}`);
    manager.log(`Database: ${db.name || '(database file in project directory)'}`);
    if (manager.getSetting('lastPipelineStatus', '') === 'running') {
        const recoveredAt = new Date().toISOString();
        const startedAt = manager.getSetting('lastPipelineRunAt', '');
        saveSchedulerState({
            lastPipelineFinishedAt: recoveredAt,
            lastPipelineElapsedSeconds: elapsedSecondsBetween(startedAt, recoveredAt) ?? 0,
            lastPipelineStatus: 'interrupted',
            lastPipelineMessage: 'The server restarted before the previous pipeline recorded completion.'
        });
        manager.log('The previous pipeline did not record completion before shutdown; its status was marked interrupted.', 'WARN');
    }
    setImmediate(() => {
        const resumedQc = manager.resumeInterruptedQcScan();
        const resumedLibraryCatalog = manager.resumeLibraryCatalogScan();
        if (resumedLibraryCatalog) manager.log(`Resumed library inventory scan (${resumedLibraryCatalog.id}) from its saved folder queue.`);
        if (resumedQc) manager.log(`Resumed an interrupted QC scan (${resumedQc.id}) from its saved directory queue.`);
        if (manager.resumeCoverUpdateJobs()) manager.log('Resumed pending static chapter-cover updates from the saved queue.');
        if (manager.resumeChapterCoverJobs()) manager.log('Resumed pending generated chapter-cover updates from the saved queue.');
        if (manager.resumeKavitaAutoCoverBulkJobs()) manager.log('Resumed pending Kavita Auto Cover bulk operation.');
        refreshScheduler();
    });
});

function shutdown(signal) {
    manager.log(`Received ${signal}; shutting down gracefully.`);
    if (scheduledTask) scheduledTask.stop();
    server.close(() => {
        try { db.close(); } catch (_) {}
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, server };
