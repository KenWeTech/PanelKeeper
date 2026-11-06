'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { registerSqliteTextFunctions } = require('./utils/text-utils');

const configuredDbPath = process.env.DB_PATH;
const dbPath = configuredDbPath
    ? path.resolve(configuredDbPath)
    : path.join(__dirname, 'panelkeeper.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
registerSqliteTextFunctions(db);

db.exec(`
    CREATE TABLE IF NOT EXISTS processed_files (
        path TEXT PRIMARY KEY,
        size INTEGER,
        mtime INTEGER,
        processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS series_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_folder TEXT NOT NULL UNIQUE,
        target_series TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        source_path TEXT NOT NULL DEFAULT '',
        source_file_count INTEGER NOT NULL DEFAULT 0,
        source_last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS job_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        message TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'INFO'
    );

    CREATE TABLE IF NOT EXISTS pending_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        destination_path TEXT NOT NULL,
        target_series TEXT NOT NULL,
        chapter_key TEXT NOT NULL,
        chapter_label TEXT NOT NULL,
        source_size INTEGER NOT NULL DEFAULT 0,
        destination_size INTEGER NOT NULL DEFAULT 0,
        decision_reason TEXT NOT NULL DEFAULT '',
        source_page_count INTEGER NOT NULL DEFAULT 0,
        destination_page_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        resolution TEXT
    );

    CREATE TABLE IF NOT EXISTS file_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        target_series TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_pending_conflicts_source_status ON pending_conflicts(status, source_path);
    CREATE INDEX IF NOT EXISTS idx_pending_conflicts_destination_status ON pending_conflicts(status, destination_path);

    CREATE TABLE IF NOT EXISTS chapter_overrides (
        path TEXT PRIMARY KEY,
        chapter_label TEXT NOT NULL,
        chapter_key TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recovery_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_path TEXT NOT NULL,
        backup_path TEXT NOT NULL,
        series TEXT NOT NULL,
        created_at TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'available'
    );

    CREATE INDEX IF NOT EXISTS idx_job_log_timestamp ON job_log(id DESC);
    CREATE INDEX IF NOT EXISTS idx_conflicts_status ON pending_conflicts(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_file_issues_status ON file_issues(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_items(status, created_at DESC);

    -- A persistent, searchable inventory of chapters in each library manga.
    -- Catalog scans are directory-based and resumable; this is not the full QC cache.
    CREATE TABLE IF NOT EXISTS library_series_state (
        series TEXT PRIMARY KEY,
        completed INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        missing_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        unparsed_count INTEGER NOT NULL DEFAULT 0,
        special_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_chapter_inventory (
        path TEXT PRIMARY KEY,
        series TEXT NOT NULL,
        file_name TEXT NOT NULL,
        chapter_key TEXT,
        chapter_label TEXT,
        chapter_number REAL,
        letter_suffix TEXT NOT NULL DEFAULT '',
        is_special INTEGER NOT NULL DEFAULT 0,
        volume_key TEXT NOT NULL DEFAULT '',
        volume_label TEXT NOT NULL DEFAULT '',
        volume_number REAL,
        volume_end_number REAL,
        is_volume INTEGER NOT NULL DEFAULT 0,
        scanned_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_library_inventory_series ON library_chapter_inventory(series, chapter_number, letter_suffix);
    CREATE INDEX IF NOT EXISTS idx_library_inventory_key ON library_chapter_inventory(series, chapter_key);

    -- A completed manga keeps a baseline of chapter identities so later
    -- successful inventory scans can detect files that have disappeared,
    -- including missing chapters after the last currently present number.
    CREATE TABLE IF NOT EXISTS library_completion_tracking (
        series TEXT PRIMARY KEY,
        baseline_ready INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_completed_chapters (
        series TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        chapter_label TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        missing_since TEXT,
        notified_at TEXT,
        last_attempt_at TEXT,
        PRIMARY KEY(series, identity_key)
    );
    CREATE INDEX IF NOT EXISTS idx_completed_chapters_series_missing
        ON library_completed_chapters(series, missing_since);
    CREATE INDEX IF NOT EXISTS idx_completed_chapters_missing_series
        ON library_completed_chapters(lower(series)) WHERE missing_since IS NOT NULL;

    -- Stable Kavita SP## assignments for named Specials. This lets an unnamed
    -- Special label keep the same numeric marker across rescans and reruns.
    -- Volume handling is opt-in per destination manga. 'off' preserves the
    -- existing chapter-only behavior; 'volume-chapters' separates chapter IDs
    -- by volume; 'volume-only' treats each CBZ as a complete volume.
    CREATE TABLE IF NOT EXISTS series_volume_settings (
        series TEXT PRIMARY KEY,
        volume_mode TEXT NOT NULL DEFAULT 'off',
        updated_at TEXT NOT NULL
    );

    -- Per-destination-manga filename terms that should be ignored by the
    -- chapter parser. One set is shared by every mapped source for the manga.
    CREATE TABLE IF NOT EXISTS series_ignored_terms (
        series TEXT PRIMARY KEY,
        terms_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS series_special_numbers (
        series TEXT NOT NULL,
        special_key TEXT NOT NULL,
        special_number INTEGER NOT NULL,
        special_title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(series, special_key)
    );
    CREATE INDEX IF NOT EXISTS idx_series_special_number ON series_special_numbers(series, special_number);

    CREATE TABLE IF NOT EXISTS library_catalog_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        total_series INTEGER NOT NULL DEFAULT 0,
        done_series INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
    );

    CREATE TABLE IF NOT EXISTS library_catalog_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        series TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        UNIQUE(job_id, series),
        FOREIGN KEY(job_id) REFERENCES library_catalog_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_library_catalog_queue ON library_catalog_queue(job_id, status, id);

    -- Additional physical download paths can feed the same manga series.
    CREATE TABLE IF NOT EXISTS series_mapping_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mapping_id INTEGER NOT NULL,
        source_folder TEXT NOT NULL,
        source_path TEXT NOT NULL UNIQUE,
        source_file_count INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT,
        UNIQUE(mapping_id, source_path),
        FOREIGN KEY(mapping_id) REFERENCES series_mappings(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mapping_sources_path ON series_mapping_sources(source_path);
    CREATE INDEX IF NOT EXISTS idx_mapping_sources_folder ON series_mapping_sources(source_folder COLLATE NOCASE);

    -- Cover rules are attached to the destination manga name and carried forward
    -- when a mapping is renamed. Managed archive entries provide an additional
    -- idempotency marker inside every CBZ.
    CREATE TABLE IF NOT EXISTS series_cover_rules (
        target_series TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        cover_path TEXT NOT NULL DEFAULT '',
        last_job_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cover_insertions (
        archive_path TEXT PRIMARY KEY,
        series TEXT NOT NULL,
        cover_path TEXT NOT NULL,
        cover_hash TEXT NOT NULL,
        archive_size INTEGER NOT NULL DEFAULT 0,
        archive_mtime INTEGER NOT NULL DEFAULT 0,
        applied_at TEXT NOT NULL
    );

    -- Optional per-manga mapping to a Kavita series-level (main manga) cover.
    -- API credentials are stored only in settings and never returned to the browser.
    CREATE TABLE IF NOT EXISTS series_kavita_cover_sources (
        target_series TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        auto_cover_enabled INTEGER NOT NULL DEFAULT 0,
        kavita_series_id INTEGER NOT NULL DEFAULT 0,
        kavita_series_name TEXT NOT NULL DEFAULT '',
        last_job_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cover_update_jobs (
        id TEXT PRIMARY KEY,
        series TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        cover_path TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'queued',
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
    );

    CREATE TABLE IF NOT EXISTS cover_update_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        UNIQUE(job_id, archive_path),
        FOREIGN KEY(job_id) REFERENCES cover_update_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cover_jobs_status ON cover_update_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cover_insertions_series ON cover_insertions(series, archive_path);
    CREATE INDEX IF NOT EXISTS idx_cover_items_queue ON cover_update_items(job_id, status, id);

    -- Optional per-chapter generated cover design. This takes priority over the
    -- static series-cover rule while enabled, but leaves the static rule intact.
    CREATE TABLE IF NOT EXISTS series_chapter_cover_designs (
        target_series TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        source_path TEXT NOT NULL DEFAULT '',
        template TEXT NOT NULL DEFAULT 'Chapter {number}',
        position TEXT NOT NULL DEFAULT 'top-center',
        font_size REAL NOT NULL DEFAULT 6,
        text_color TEXT NOT NULL DEFAULT '#ffffff',
        outline_color TEXT NOT NULL DEFAULT '#000000',
        outline_width REAL NOT NULL DEFAULT 3,
        panel_enabled INTEGER NOT NULL DEFAULT 1,
        panel_color TEXT NOT NULL DEFAULT '#000000',
        panel_opacity REAL NOT NULL DEFAULT 0.48,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapter_cover_insertions (
        archive_path TEXT PRIMARY KEY,
        series TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        design_hash TEXT NOT NULL,
        chapter_key TEXT NOT NULL DEFAULT '',
        archive_size INTEGER NOT NULL DEFAULT 0,
        archive_mtime INTEGER NOT NULL DEFAULT 0,
        applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapter_cover_jobs (
        id TEXT PRIMARY KEY,
        series TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        applied INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
    );

    CREATE TABLE IF NOT EXISTS chapter_cover_job_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        UNIQUE(job_id, archive_path),
        FOREIGN KEY(job_id) REFERENCES chapter_cover_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chapter_cover_jobs_status ON chapter_cover_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chapter_cover_insertions_series ON chapter_cover_insertions(series, archive_path);
    CREATE INDEX IF NOT EXISTS idx_chapter_cover_items_queue ON chapter_cover_job_items(job_id, status, id);

    -- Background bulk management for Kavita Auto Cover. The requested series
    -- list and per-series outcomes are persisted so a large batch can resume
    -- safely after a PanelKeeper restart.
    CREATE TABLE IF NOT EXISTS kavita_auto_cover_bulk_jobs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        series_json TEXT NOT NULL,
        results_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        total INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kavita_auto_cover_bulk_status ON kavita_auto_cover_bulk_jobs(status, created_at);
`);

const defaultSettings = {
    sourceRoot: process.env.MANGA_SOURCE_ROOT || '',
    destination: process.env.MANGA_DESTINATION || '',
    sourceFolderMode: 'auto',
    cronSchedule: '30 2,6,10,14,18,22 * * *',
    schedulePreset: 'off',
    scheduleStartTime: '02:30',
    schedulerTimezone: 'system',
    webhookUrl: '',
    notifyPipelineCompleted: 'true',
    notifyPipelineFailed: 'true',
    notifyPipelineNotRun: 'true',
    notifyAttention: 'true',
    notifyConflicts: 'true',
    notifyQC: 'true',
    notifyCompletedChapterMissing: 'true',
    notifyIncludeDuration: 'true',
    notifyIncludeFolderSummary: 'true',
    notifyIncludeFailureDetails: 'true',
    notifyIncludeMetadata: 'true',
    notifyIncludeTimestamp: 'true',
    notifyIncludeTestId: 'true',
    pipelineOrder: JSON.stringify(['move', 'remove_xml']),
    autoQC: 'false',
    autoQCIntervalHours: '168',
    comicInfoPolicy: 'leave',
    removeComicInfo: 'false',
    comicInfoGlobalTemplate: '',
    comicInfoSeriesTemplates: '{}',
    backupRetentionDays: '14',
    minimumFileAgeSeconds: '120',
    logRetention: '5000',
    logFileMaxMB: '2'
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const initializeDefaults = db.transaction(() => {
    for (const [key, value] of Object.entries(defaultSettings)) insertSetting.run(key, String(value));
});
initializeDefaults();

module.exports = db;
module.exports.dbPath = dbPath;
module.exports.defaultSettings = defaultSettings;
