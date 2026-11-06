'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const mainDb = require('./database');
const { registerSqliteTextFunctions } = require('./utils/text-utils');

const mainPath = path.resolve(mainDb.dbPath || path.join(__dirname, 'panelkeeper.db'));
const defaultQcPath = path.join(
    path.dirname(mainPath),
    `${path.basename(mainPath, path.extname(mainPath))}_qc.db`
);
const qcDbPath = path.resolve(process.env.QC_DB_PATH || defaultQcPath);
if (qcDbPath === mainPath) {
    throw new Error('QC_DB_PATH must point to a separate database file from DB_PATH.');
}
fs.mkdirSync(path.dirname(qcDbPath), { recursive: true });

const qcDb = new Database(qcDbPath);
qcDb.pragma('journal_mode = WAL');
qcDb.pragma('foreign_keys = ON');
qcDb.pragma('busy_timeout = 5000');
registerSqliteTextFunctions(qcDb);

qcDb.exec(`
    CREATE TABLE IF NOT EXISTS qc_cache (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        issues TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        has_issues INTEGER NOT NULL DEFAULT 0,
        scanned_at TEXT NOT NULL,
        parser_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS qc_scan_runs (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        auto_fix INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        done INTEGER NOT NULL DEFAULT 0,
        issue_count INTEGER NOT NULL DEFAULT 0,
        cache_hits INTEGER NOT NULL DEFAULT 0,
        repaired INTEGER NOT NULL DEFAULT 0,
        error TEXT
    );

    CREATE TABLE IF NOT EXISTS qc_scan_dirs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(run_id, path),
        FOREIGN KEY(run_id) REFERENCES qc_scan_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS qc_dismissed (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        dismissed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_qc_cache_has_issues ON qc_cache(has_issues, path);
    CREATE INDEX IF NOT EXISTS idx_qc_runs_root_status ON qc_scan_runs(root, status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_qc_scan_dirs_queue ON qc_scan_dirs(run_id, status, id);
`);

qcDb.dbPath = qcDbPath;
module.exports = qcDb;
