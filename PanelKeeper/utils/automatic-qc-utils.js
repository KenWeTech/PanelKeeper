'use strict';

const AUTO_QC_ACTION_KEYS = Object.freeze([
    'autoQCRepairNames',
    'autoQCOrganizeSpecials',
    'autoQCApplyComicInfo',
    'autoQCResolveDuplicates',
    'autoQCRouteToReview',
    'autoQCRouteUnsupportedImages'
]);

const DEFAULT_AUTO_QC_ACTION_SETTINGS = Object.freeze(Object.fromEntries(
    AUTO_QC_ACTION_KEYS.map(key => [key, key === 'autoQCRouteUnsupportedImages' ? 'false' : 'true'])
));

function getAutomaticQcActions(readSetting) {
    if (typeof readSetting !== 'function') throw new TypeError('A settings reader is required.');
    const enabled = key => String(readSetting(key, 'true')).toLowerCase() === 'true';
    const repairNames = enabled('autoQCRepairNames');
    return {
        repairNames,

        organizeSpecials: repairNames && enabled('autoQCOrganizeSpecials'),
        applyComicInfo: enabled('autoQCApplyComicInfo'),
        resolveDuplicates: enabled('autoQCResolveDuplicates'),
        routeToReview: enabled('autoQCRouteToReview'),

        routeUnsupportedImages: String(readSetting('autoQCRouteUnsupportedImages', 'false')).toLowerCase() === 'true'
    };
}

function hasAutomaticQcActionableIssue(issues, actions, comicInfoPolicy) {
    if (!Array.isArray(issues) || !actions) return false;
    return issues.some(issue => {
        switch (issue) {
            case 'bad_name':
                return actions.repairNames && (actions.organizeSpecials || !issues.includes('special_needs_kavita_path'));
            case 'unparsed_chapter':
                return actions.routeToReview || (actions.repairNames && (actions.organizeSpecials || !issues.includes('special_needs_kavita_path')));
            case 'special_needs_kavita_path':
                return actions.organizeSpecials;
            case 'has_xml':
                return actions.applyComicInfo && comicInfoPolicy !== 'leave';
            case 'unsupported_image_format':
                return actions.routeUnsupportedImages;
            case 'bad_archive':
            case 'unsupported_archive':
            case 'xml_cleanup_failed':
            case 'move_failed':
                return actions.routeToReview;
            default:
                return false;
        }
    });
}

module.exports = {
    AUTO_QC_ACTION_KEYS,
    DEFAULT_AUTO_QC_ACTION_SETTINGS,
    getAutomaticQcActions,
    hasAutomaticQcActionableIssue
};
