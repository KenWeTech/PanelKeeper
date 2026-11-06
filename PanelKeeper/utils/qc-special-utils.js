'use strict';

function sanitizeSpecialQcIssue({ issues, reason = '', isSpecial, sourcePath, destinationPath, samePath }) {
    const currentIssues = Array.isArray(issues) ? [...issues] : [];
    if (!currentIssues.includes('special_needs_kavita_path')) {
        return { issues: currentIssues, reason: String(reason || ''), changed: false };
    }
    const canonical = !isSpecial || (typeof samePath === 'function' && samePath(sourcePath, destinationPath));
    if (!canonical) return { issues: currentIssues, reason: String(reason || ''), changed: false };
    const filtered = currentIssues.filter(issue => issue !== 'special_needs_kavita_path');
    const cleanedReason = !isSpecial ? '' : String(reason || '').replace(/Special recognized as .*?Kavita Specials belong in the Specials subfolder and use an SP## filename\.?\s*/i, '').trim();
    return { issues: filtered, reason: cleanedReason, changed: true };
}

module.exports = { sanitizeSpecialQcIssue };
