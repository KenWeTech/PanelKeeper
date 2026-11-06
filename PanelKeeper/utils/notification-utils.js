'use strict';

const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
    notifyPipelineCompleted: true,
    notifyPipelineFailed: true,
    notifyPipelineNotRun: true,
    notifyAttention: true,
    notifyConflicts: true,
    notifyQC: true,
    notifyCompletedChapterMissing: true,
    notifyIncludeDuration: true,
    notifyIncludeFolderSummary: true,
    notifyIncludeFailureDetails: true,
    notifyIncludeMetadata: true,
    notifyIncludeTimestamp: true,
    notifyIncludeTestId: true
});

const EVENT_PREFERENCE_KEYS = Object.freeze({
    pipeline_completed: 'notifyPipelineCompleted',
    pipeline_failed: 'notifyPipelineFailed',
    pipeline_not_run: 'notifyPipelineNotRun',
    attention: 'notifyAttention',
    conflicts: 'notifyConflicts',
    qc: 'notifyQC',
    completed_chapter_missing: 'notifyCompletedChapterMissing'
});

function toBoolean(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readNotificationPreferences(getSetting) {
    const preferences = {};
    for (const [key, fallback] of Object.entries(DEFAULT_NOTIFICATION_PREFERENCES)) {
        preferences[key] = toBoolean(getSetting(key, String(fallback)), fallback);
    }
    return preferences;
}

function shouldSendEvent(event, preferences = DEFAULT_NOTIFICATION_PREFERENCES) {
    const preferenceKey = EVENT_PREFERENCE_KEYS[String(event || '').trim()];
    return preferenceKey ? preferences[preferenceKey] !== false : true;
}

function buildPipelineMessage(event, details = {}, preferences = DEFAULT_NOTIFICATION_PREFERENCES) {
    if (event === 'pipeline_completed') {
        const parts = ['PanelKeeper pipeline completed.'];
        if (preferences.notifyIncludeDuration !== false && Number.isFinite(Number(details.elapsedSeconds))) {
            parts.push(`Duration: ${Math.max(0, Number(details.elapsedSeconds))} second(s).`);
        }
        if (preferences.notifyIncludeFolderSummary !== false
            && Number.isFinite(Number(details.folders)) && Number.isFinite(Number(details.matched))) {
            parts.push(`Source folders found: ${Math.max(0, Number(details.folders))}; mapped folders: ${Math.max(0, Number(details.matched))}.`);
        }
        return parts.join('\n');
    }
    if (event === 'pipeline_failed') {
        const reason = String(details.reason || '').trim();
        return preferences.notifyIncludeFailureDetails !== false && reason
            ? `PanelKeeper pipeline FAILED.\nReason: ${reason}`
            : 'PanelKeeper pipeline FAILED.';
    }
    if (event === 'pipeline_not_run') {
        const reason = String(details.reason || '').trim();
        return preferences.notifyIncludeFailureDetails !== false && reason
            ? `PanelKeeper pipeline did not run.\nReason: ${reason}`
            : 'PanelKeeper pipeline did not run.';
    }
    return String(details.message || 'PanelKeeper notification.');
}

function buildWebhookPayload(message, event, testId, timestamp, preferences = DEFAULT_NOTIFICATION_PREFERENCES) {
    const payload = { message: String(message || 'PanelKeeper notification.') };
    if (preferences.notifyIncludeMetadata !== false) {
        payload.source = 'PanelKeeper';
        payload.event = String(event || 'notification');
        payload.event_type = `panelkeeper_${String(event || 'notification')}`;
    }
    if (preferences.notifyIncludeTimestamp !== false) payload.timestamp = String(timestamp || new Date().toISOString());
    if (preferences.notifyIncludeTestId !== false) payload.test_id = String(testId || '');
    return payload;
}

module.exports = {
    DEFAULT_NOTIFICATION_PREFERENCES,
    EVENT_PREFERENCE_KEYS,
    toBoolean,
    readNotificationPreferences,
    shouldSendEvent,
    buildPipelineMessage,
    buildWebhookPayload
};
