'use strict';

const MONTH_NAMES = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const DAY_NAMES = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });
const formatterCache = new Map();

function resolveSchedulerTimezone(requested = 'system', systemTimezone = 'UTC') {
    const value = String(requested || 'system').trim();
    if (!value || value.toLowerCase() === 'system') return systemTimezone || 'UTC';
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
}

function schedulerDateValue(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    if (typeof value === 'number') {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    if (typeof value === 'string') {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    if (typeof value?.toJSDate === 'function') {
        const date = value.toJSDate();
        return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
    }
    return null;
}

function elapsedSecondsBetween(startValue, finishValue) {
    const start = Date.parse(startValue || '');
    const finish = Date.parse(finishValue || '');
    return Number.isFinite(start) && Number.isFinite(finish) && finish >= start
        ? Math.max(0, Math.round((finish - start) / 1000))
        : null;
}

function resolveElapsedSeconds(storedValue, startValue, finishValue) {
    if (storedValue !== '' && storedValue !== null && storedValue !== undefined && Number.isFinite(Number(storedValue))) {
        return Math.max(0, Number(storedValue));
    }
    return elapsedSecondsBetween(startValue, finishValue);
}

function getFormatter(timeZone) {
    const key = String(timeZone || 'UTC');
    if (!formatterCache.has(key)) {
        formatterCache.set(key, new Intl.DateTimeFormat('en-US', {
            timeZone: key,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23'
        }));
    }
    return formatterCache.get(key);
}

function zonedParts(epochMs, formatter) {
    const values = Object.create(null);
    for (const part of formatter.formatToParts(new Date(epochMs))) {
        if (part.type !== 'literal') values[part.type] = Number(part.value);
    }
    return {
        year: values.year, month: values.month, day: values.day,
        hour: values.hour, minute: values.minute, second: values.second
    };
}

function parseCronField(expression, min, max, names = null, normalize = value => value) {
    const values = new Set();
    const text = String(expression || '').toLowerCase();
    if (!text) throw new Error('Empty cron field.');
    const parseRawValue = raw => {
        const token = String(raw).toLowerCase();
        const named = names && Object.prototype.hasOwnProperty.call(names, token) ? names[token] : Number(token);
        if (!Number.isInteger(named) || named < min || named > max) throw new Error(`Invalid cron value: ${raw}`);
        return named;
    };
    const parseValue = raw => normalize(parseRawValue(raw));
    for (const part of text.split(',')) {
        if (!part) throw new Error('Invalid empty cron list item.');
        const [base, stepText, ...extra] = part.split('/');
        if (extra.length) throw new Error(`Invalid cron step: ${part}`);
        const step = stepText === undefined ? 1 : Number(stepText);
        if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
        let start; let end;
        if (base === '*' || base === '?') { start = min; end = max; }
        else if (base.includes('-')) {
            const range = base.split('-');
            if (range.length !== 2) throw new Error(`Invalid cron range: ${part}`);
            const rawStart = parseRawValue(range[0]);
            const rawEnd = parseRawValue(range[1]);
            start = rawStart;
            end = rawEnd;

            if (end < start) {
                for (let value = start; value <= max; value += step) values.add(normalize(value));
                for (let value = min; value <= end; value += step) values.add(normalize(value));
                continue;
            }
        } else {
            start = parseValue(base);
            end = stepText === undefined ? start : max;
        }
        for (let value = start; value <= end; value += step) values.add(normalize(value));
    }
    return { values: [...values].sort((a, b) => a - b), wildcard: text === '*' || text === '?' || text === '*/1' };
}

function parseCronExpression(expression) {
    const normalizedExpression = normalizeCronExpression(expression);
    const fields = normalizedExpression.split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) throw new Error('Only standard five- or six-field cron expressions are supported for next-run display.');
    const sixFields = fields.length === 6;
    const [secondsField, minutesField, hoursField, domField, monthField, dowField] = sixFields
        ? fields
        : ['0', ...fields];
    const seconds = parseCronField(secondsField, 0, 59);
    const minutes = parseCronField(minutesField, 0, 59);
    const hours = parseCronField(hoursField, 0, 23);
    const daysOfMonth = parseCronField(domField, 1, 31);
    const months = parseCronField(monthField, 1, 12, MONTH_NAMES);
    const daysOfWeek = parseCronField(dowField, 0, 7, DAY_NAMES, value => value === 7 ? 0 : value);
    return { seconds: seconds.values, minutes: minutes.values, hours: hours.values, daysOfMonth, months: months.values, daysOfWeek };
}

function normalizeCronExpression(expression) {
    const value = String(expression || '').trim();
    const aliases = {
        '@yearly': '0 0 1 1 *',
        '@annually': '0 0 1 1 *',
        '@monthly': '0 0 1 * *',
        '@weekly': '0 0 * * 0',
        '@daily': '0 0 * * *',
        '@midnight': '0 0 * * *',
        '@hourly': '0 * * * *'
    };
    return aliases[value.toLowerCase()] || value;
}

function describeCronSchedule(expression) {
    const raw = String(expression || '').trim();
    try {
        const normalized = normalizeCronExpression(raw);
        const cron = parseCronExpression(normalized);
        const { seconds, minutes, hours, daysOfMonth, months, daysOfWeek } = cron;
        const simpleDaily = daysOfMonth.wildcard && months.length === 12 && daysOfWeek.wildcard;
        const simpleWeeklySunday = daysOfMonth.wildcard && months.length === 12 && !daysOfWeek.wildcard
            && daysOfWeek.values.length === 1 && daysOfWeek.values[0] === 0;
        const isZeroSeconds = seconds.length === 1 && seconds[0] === 0;
        if ((simpleDaily || simpleWeeklySunday) && isZeroSeconds && minutes.length === 1) {
            const minute = minutes[0];
            const clock = (hour) => new Intl.DateTimeFormat('en-US', {
                timeZone: 'UTC', hour: 'numeric', minute: '2-digit'
            }).format(new Date(Date.UTC(2020, 0, 1, hour, minute, 0)));
            if (simpleWeeklySunday && hours.length === 1) return `Weekly on Sunday at ${clock(hours[0])}`;
            if (simpleDaily) {
                if (hours.length === 24) return minute ? `Every hour at :${String(minute).padStart(2, '0')}` : 'Every hour';
                if (hours.length > 1) {
                    const startHour = hours[0];
                    const step = hours[1] - hours[0];
                    const expectedCount = Math.ceil((24 - startHour) / step);
                    const uniform = hours.every((hour, index) => hour === startHour + index * step);
                    if (step > 0 && uniform && hours.length === expectedCount && 24 % step === 0) {
                        if (hours.includes(0)) {
                            return minute
                                ? `Every ${step} hours at :${String(minute).padStart(2, '0')} (avoids midnight)`
                                : `Every ${step} hours`;
                        }
                        return `Every ${step} hours starting at ${clock(startHour)} (avoids midnight)`;
                    }
                }
                if (hours.length === 1) {
                    if (hours[0] === 0 && minute === 0) return 'Daily at midnight';
                    return `Daily at ${clock(hours[0])}`;
                }
            }
        }
        if (simpleDaily && isZeroSeconds && hours.length === 24 && minutes.length > 1) {
            const step = minutes[1] - minutes[0];
            if (minutes[0] === 0 && minutes.every((minute, index) => minute === index * step) && 60 % step === 0) {
                return `Every ${step} minutes`;
            }
        }
        return raw || 'Custom schedule';
    } catch (_) {
        return raw || 'Custom schedule';
    }
}

function cronDayMatches(parts, cron) {
    if (!cron.months.includes(parts.month)) return false;
    const domMatch = cron.daysOfMonth.values.includes(parts.day);
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const dowMatch = cron.daysOfWeek.values.includes(weekday);

    return domMatch && dowMatch;
}

function offsetForEpoch(epochMs, formatter) {
    const roundedEpoch = Math.floor(epochMs / 1000) * 1000;
    const local = zonedParts(roundedEpoch, formatter);
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    return representedAsUtc - roundedEpoch;
}

function wallTimeToEpochs(parts, timeZone, formatter, offsets) {
    const wallUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const matches = [];
    for (const offset of offsets) {
        const candidate = wallUtc - offset;
        const actual = zonedParts(candidate, formatter);
        if (actual.year === parts.year && actual.month === parts.month && actual.day === parts.day &&
            actual.hour === parts.hour && actual.minute === parts.minute && actual.second === parts.second) {
            matches.push(candidate);
        }
    }
    return matches;
}

function calculateNextCronRun(expression, afterValue = new Date(), timeZone = 'UTC', maxDays = 366 * 8) {
    const after = afterValue instanceof Date ? afterValue.getTime() : new Date(afterValue).getTime();
    if (!Number.isFinite(after)) throw new Error('Invalid reference date for cron calculation.');
    const cron = parseCronExpression(expression);
    const formatter = getFormatter(timeZone);
    const localNow = zonedParts(after, formatter);
    const firstDate = Date.UTC(localNow.year, localNow.month - 1, localNow.day);

    for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
        const dayDate = new Date(firstDate + dayOffset * 86400000);
        const year = dayDate.getUTCFullYear();
        const month = dayDate.getUTCMonth() + 1;
        const day = dayDate.getUTCDate();
        const dayParts = { year, month, day };
        if (!cronDayMatches(dayParts, cron)) continue;

        const localNoonUtc = Date.UTC(year, month - 1, day, 12);
        const offsets = new Set();
        for (const hoursAround of [-36, -12, 0, 12, 36]) {
            offsets.add(offsetForEpoch(localNoonUtc + hoursAround * 3600000, formatter));
        }

        for (const hour of cron.hours) {
            for (const minute of cron.minutes) {
                for (const second of cron.seconds) {
                    const wanted = { year, month, day, hour, minute, second };
                    const candidates = wallTimeToEpochs(wanted, timeZone, formatter, offsets).sort((a, b) => a - b);

                    const candidate = candidates[0];
                    if (candidate !== undefined && candidate > after) return new Date(candidate).toISOString();
                }
            }
        }
    }
    return null;
}

function parseScheduleStartTime(value = '02:30') {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) throw new Error('Enter a schedule start time in HH:MM format.');
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error('Schedule start time must be between 00:00 and 23:59.');
    }
    return { hour, minute, value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function normalizeScheduleStartTime(preset, startTime = '02:30') {
    const parsed = parseScheduleStartTime(startTime);
    const intervalMap = { hourly: 1, every2Hours: 2, every4Hours: 4, every6Hours: 6 };
    let includesMidnightHour = false;
    if (preset === 'hourly') {
        includesMidnightHour = true;
    } else if (Object.prototype.hasOwnProperty.call(intervalMap, preset)) {
        const interval = intervalMap[preset];
        includesMidnightHour = ((0 - parsed.hour + 24) % interval) === 0;
    } else if (preset === 'daily' || preset === 'weeklySunday') {
        includesMidnightHour = parsed.hour === 0;
    }

    const minute = parsed.minute === 0 && includesMidnightHour ? 30 : parsed.minute;
    return `${String(parsed.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildPresetCron(preset, startTime = '02:30') {
    const safeStartTime = normalizeScheduleStartTime(preset, startTime);
    const { hour, minute } = parseScheduleStartTime(safeStartTime);
    const minuteText = String(minute);
    const intervalMap = { hourly: 1, every2Hours: 2, every4Hours: 4, every6Hours: 6 };
    if (Object.prototype.hasOwnProperty.call(intervalMap, preset)) {
        const interval = intervalMap[preset];
        const hours = [];
        for (let candidate = 0; candidate < 24; candidate++) {
            if ((candidate - hour + 24) % interval === 0) hours.push(candidate);
        }
        return `${minuteText} ${hours.join(',')} * * *`;
    }
    if (preset === 'daily') return `${minuteText} ${hour} * * *`;
    if (preset === 'weeklySunday') return `${minuteText} ${hour} * * 0`;
    if (preset === 'custom') return null;
    throw new Error('Choose a supported automation schedule.');
}

function cronRunsAtMidnight(expression) {
    try {
        const parsed = parseCronExpression(expression);
        return parsed.minutes.includes(0) && parsed.hours.includes(0);
    } catch (_) {
        return false;
    }
}

function inferSchedulePreset(expression) {
    const normalized = normalizeCronExpression(expression);
    const legacy = new Map([
        ['0 * * * *', { preset: 'hourly', startTime: '02:00' }],
        ['0 */2 * * *', { preset: 'every2Hours', startTime: '02:00' }],
        ['0 2-22/2 * * *', { preset: 'every2Hours', startTime: '02:00' }],
        ['0 2-22/4 * * *', { preset: 'every4Hours', startTime: '02:00' }],
        ['0 */4 * * *', { preset: 'every4Hours', startTime: '02:00' }],
        ['0 2-20/6 * * *', { preset: 'every6Hours', startTime: '02:00' }],
        ['0 */6 * * *', { preset: 'every6Hours', startTime: '02:00' }],
        ['0 0 * * *', { preset: 'daily', startTime: '00:00' }],
        ['0 6 * * *', { preset: 'daily', startTime: '06:00' }],
        ['0 0 * * 0', { preset: 'weeklySunday', startTime: '00:00' }]
    ]);
    if (legacy.has(normalized)) return { ...legacy.get(normalized) };
    const hourlyWildcard = normalized.match(/^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/);
    if (hourlyWildcard) {
        return { preset: 'hourly', startTime: `00:${String(Number(hourlyWildcard[1])).padStart(2, '0')}` };
    }
    const match = normalized.match(/^(\d{1,2})\s+([0-9,]+)\s+\*\s+\*\s+(\*|0)$/);
    if (match) {
        const minute = Number(match[1]);
        const hours = match[2].split(',').map(Number).sort((a, b) => a - b);
        const day = match[3];
        if (hours.every(value => Number.isInteger(value) && value >= 0 && value <= 23)) {
            if (hours.length === 1) return {
                preset: day === '0' ? 'weeklySunday' : 'daily',
                startTime: `${String(hours[0]).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
            };
            const step = hours[1] - hours[0];
            const uniform = step > 0 && hours.every((value, index) => value === hours[0] + index * step);
            const expected = Math.ceil((24 - hours[0]) / step);
            if (day === '*' && uniform && hours.length === expected && [1, 2, 4, 6].includes(step)) {
                const preset = step === 1 ? 'hourly' : `every${step}Hours`;
                return { preset, startTime: `${String(hours[0]).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
            }
        }
    }
    return { preset: 'custom', startTime: '02:30' };
}

module.exports = {
    resolveSchedulerTimezone,
    schedulerDateValue,
    elapsedSecondsBetween,
    resolveElapsedSeconds,
    parseCronExpression,
    calculateNextCronRun,
    describeCronSchedule,
    normalizeCronExpression,
    parseScheduleStartTime,
    buildPresetCron,
    normalizeScheduleStartTime,
    cronRunsAtMidnight,
    inferSchedulePreset
};
