'use strict';

const DEFAULT_NOTIFICATION_RETRY_MS = 12 * 60 * 60 * 1000;

function chapterSnapshotIdentity(record) {
    const chapterKey = String(record?.chapter_key || record?.chapterKey || '').trim();
    if (chapterKey) return `chapter:${chapterKey}`;
    const fileName = String(record?.file_name || record?.fileName || '').trim();
    return fileName ? `file:${fileName.toLocaleLowerCase('en-US')}` : '';
}

function normalizeCurrentChapterRecords(records, scannedAt) {
    const byIdentity = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const identityKey = chapterSnapshotIdentity(record);
        if (!identityKey || byIdentity.has(identityKey)) continue;
        byIdentity.set(identityKey, {
            identity_key: identityKey,
            chapter_label: String(record.chapter_label || record.chapterLabel || '').trim(),
            file_name: String(record.file_name || record.fileName || '').trim(),
            last_seen_at: scannedAt
        });
    }
    return [...byIdentity.values()];
}

function reconcileCompletedChapterSnapshot({ baseline = [], currentRecords = [], scannedAt = new Date().toISOString(), retryAfterMs = DEFAULT_NOTIFICATION_RETRY_MS } = {}) {
    const current = new Map(normalizeCurrentChapterRecords(currentRecords, scannedAt).map(record => [record.identity_key, record]));
    const known = new Set((Array.isArray(baseline) ? baseline : []).map(row => String(row.identity_key || '')).filter(Boolean));
    const additions = [...current.values()].filter(record => !known.has(record.identity_key));
    const updates = [];
    const notificationCandidates = [];
    const nowMs = Date.parse(scannedAt);

    for (const row of Array.isArray(baseline) ? baseline : []) {
        const identityKey = String(row.identity_key || '');
        if (!identityKey) continue;
        const present = current.get(identityKey);
        if (present) {
            updates.push({
                identity_key: identityKey,
                last_seen_at: scannedAt,
                missing_since: null,
                notified_at: null,
                last_attempt_at: null,
                chapter_label: present.chapter_label || row.chapter_label || '',
                file_name: present.file_name || row.file_name || ''
            });
            continue;
        }

        const missingSince = row.missing_since || scannedAt;
        const lastAttemptMs = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN;
        const retryReady = !Number.isFinite(lastAttemptMs) || !Number.isFinite(nowMs) || (nowMs - lastAttemptMs) >= retryAfterMs;
        updates.push({
            identity_key: identityKey,
            last_seen_at: row.last_seen_at || '',
            missing_since: missingSince,
            notified_at: row.notified_at || null,
            last_attempt_at: row.last_attempt_at || null,
            chapter_label: row.chapter_label || '',
            file_name: row.file_name || ''
        });
        if (!row.notified_at && retryReady) {
            notificationCandidates.push({
                identity_key: identityKey,
                label: String(row.chapter_label || row.file_name || identityKey.replace(/^(chapter|file):/, '')).trim(),
                missingSince
            });
        }
    }

    return { additions, updates, notificationCandidates };
}

function buildCompletedChapterMissingMessage(series, missingChapters, maxNames = 30) {
    const names = [...new Set((Array.isArray(missingChapters) ? missingChapters : [])
        .map(item => String(item?.label || item || '').trim()).filter(Boolean))];
    if (!names.length) return '';
    const shown = names.slice(0, Math.max(1, Number(maxNames) || 30));
    const remaining = names.length - shown.length;
    return [
        `Previously tracked chapter files are missing from completed manga: ${String(series || '').trim()}.`,
        `Missing (${names.length}): ${shown.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}.`,
        'The library folder was accessible during the inventory scan. Restore the missing files or review the manga inventory if the removals were intentional.'
    ].join('\n');
}

module.exports = {
    DEFAULT_NOTIFICATION_RETRY_MS,
    chapterSnapshotIdentity,
    normalizeCurrentChapterRecords,
    reconcileCompletedChapterSnapshot,
    buildCompletedChapterMissingMessage
};
