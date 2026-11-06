'use strict';

const MAX_XML_BYTES = 256 * 1024;

const FIELD_NAMES = Object.freeze([
    'Series', 'LocalizedSeries', 'SeriesGroup', 'Number', 'Count', 'Volume', 'AlternateSeries', 'AlternateNumber',
    'AlternateCount', 'StoryArc', 'StoryArcNumber', 'Title', 'Summary', 'Publisher', 'Imprint', 'Genre',
    'Web', 'LanguageISO', 'Format', 'BlackAndWhite', 'Manga', 'Characters', 'Teams',
    'Locations', 'ScanInformation', 'Storyboard', 'Notes', 'PageCount', 'CommunityRating',
    'AgeRating', 'MainCharacterOrTeam', 'Review', 'GTIN', 'BookType', 'CriticalRating', 'SeriesSort', 'TitleSort',
    'Writer', 'Penciller', 'Inker', 'Colorist', 'Letterer', 'CoverArtist', 'Editor',
    'Translator', 'PublisherImprint', 'Year', 'Month', 'Day', 'Isbn', 'Tags', 'Pages'
]);

function escapeXml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function validateComicInfoXml(xml) {
    const value = String(xml ?? '').replace(/^\uFEFF/, '').trim();
    if (!value) throw new Error('ComicInfo.xml cannot be empty.');
    if (Buffer.byteLength(value, 'utf8') > MAX_XML_BYTES) throw new Error('ComicInfo.xml must be 256 KiB or smaller.');
    if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('DOCTYPE and ENTITY declarations are not allowed in ComicInfo.xml.');
    if (!/^<\?xml\s[^?]*\?>\s*/i.test(value) && !/^<ComicInfo\b/i.test(value)) {
        throw new Error('The XML must start with an XML declaration or a ComicInfo root element.');
    }
    if (!/<ComicInfo\b[^>]*>[\s\S]*<\/ComicInfo\s*>$/i.test(value) && !/<ComicInfo\b[^>]*\/\s*>$/i.test(value)) {
        throw new Error('ComicInfo.xml must contain one complete ComicInfo root element.');
    }

    const body = value.replace(/^<\?xml[^?]*\?>\s*/i, '').replace(/<!--([\s\S]*?)-->/g, '');
    const stack = [];
    const tags = body.match(/<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?>/g) || [];
    for (const tag of tags) {
        if (/^<\?/.test(tag) || /^<!/.test(tag)) continue;
        if (/^<\//.test(tag)) {
            const name = tag.match(/^<\/\s*([\w:.-]+)/)?.[1];
            if (!name || stack.pop() !== name) throw new Error('ComicInfo.xml contains mismatched or incorrectly nested tags.');
        } else if (!/\/\s*>$/.test(tag)) {
            const name = tag.match(/^<\s*([\w:.-]+)/)?.[1];
            if (name) stack.push(name);
        }
    }
    if (stack.length) throw new Error('ComicInfo.xml contains unclosed tags.');
    return value;
}

function decodeXmlText(value) {
    return String(value || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (_match, code) => {
            const number = Number(code);
            return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
        })
        .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
            const number = parseInt(code, 16);
            return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
        });
}

function getDirectFields(xml) {
    const value = validateComicInfoXml(xml);
    const rootStart = value.match(/<ComicInfo\b[^>]*>/i);
    const rootEndIndex = value.toLowerCase().lastIndexOf('</comicinfo>');
    const body = rootStart ? value.slice(value.indexOf(rootStart[0]) + rootStart[0].length, rootEndIndex) : '';
    const fields = new Map();

    const pattern = /<([A-Za-z_][\w:.-]*)(?:\s+[^<>]*?)?>([\s\S]*?)<\/\1\s*>|<([A-Za-z_][\w:.-]*)(?:\s+[^<>]*?)?\s*\/>/g;
    let match;
    while ((match = pattern.exec(body))) {
        const name = match[1] || match[3];
        const raw = match[2] || '';
        const textValue = decodeXmlText(raw.replace(/<[^>]+>/g, '')).trim();
        const hasNestedMarkup = /<[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?\s*>/.test(raw);
        fields.set(name.toLowerCase(), { name, raw, value: textValue || (hasNestedMarkup ? '__PRESENT__' : ''), selfClosing: Boolean(match[3]) });
    }
    return { value, fields, rootEndIndex };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upgradeComicInfoXml(existingXml, templateXml) {
    const existing = getDirectFields(existingXml);
    const template = getDirectFields(templateXml);
    let result = existing.value;
    const additions = [];
    for (const [key, incoming] of template.fields) {
        if (!incoming.value) continue;
        const current = existing.fields.get(key);
        if (current && current.value) continue;
        const escapedName = escapeRegExp(current?.name || incoming.name);
        if (current) {
            if (current.selfClosing) {
                const selfClosing = new RegExp(`<${escapedName}(?:\\s[^<>]*?)?\\s*/>`, 'i');
                const content = /<[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?\s*>/.test(incoming.raw) ? incoming.raw : escapeXml(incoming.value);
                result = result.replace(selfClosing, `<${current.name}>${content}</${current.name}>`);
            } else {
                const pattern = new RegExp(`(<${escapedName}(?:\\s[^>]*)?>)[\\s\\S]*?(<\\/${escapedName}\\s*>)`, 'i');
                const content = /<[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?\s*>/.test(incoming.raw) ? incoming.raw : escapeXml(incoming.value);
                result = result.replace(pattern, (_match, openTag, closeTag) => `${openTag}${content}${closeTag}`);
            }
        } else {
            additions.push(`  <${incoming.name}>${escapeXml(incoming.value)}</${incoming.name}>`);
        }
    }
    if (additions.length) {
        const closing = result.toLowerCase().lastIndexOf('</comicinfo>');
        result = `${result.slice(0, closing).trimEnd()}\n${additions.join('\n')}\n${result.slice(closing)}`;
    }
    return validateComicInfoXml(result);
}

function setDirectFieldValue(xml, fieldName, value) {
    const field = String(fieldName || '').trim();
    if (!/^[A-Za-z_][\w:.-]*$/.test(field)) throw new Error('Invalid ComicInfo field name.');
    const text = escapeXml(value);
    const escaped = escapeRegExp(field);
    const paired = new RegExp(`<(${escaped})(\\b[^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`, 'i');
    const selfClosing = new RegExp(`<(${escaped})(\\b[^>]*)\\/\\s*>`, 'i');
    let result = String(xml);
    if (paired.test(result)) {
        result = result.replace(paired, (_match, name, attributes) => `<${name}${attributes}>${text}</${name}>`);
    } else if (selfClosing.test(result)) {
        result = result.replace(selfClosing, (_match, name, attributes) => `<${name}${attributes}>${text}</${name}>`);
    } else {
        const closing = result.toLowerCase().lastIndexOf('</comicinfo>');
        if (closing < 0) throw new Error('ComicInfo.xml is missing its closing root element.');
        result = `${result.slice(0, closing).trimEnd()}\n  <${field}>${text}</${field}>\n${result.slice(closing)}`;
    }
    return result;
}

function updateComicInfoIdentity(existingXml, context = {}) {
    const current = validateComicInfoXml(existingXml);
    const nextFields = [
        ['Series', context.Series],
        ['SeriesSort', context.Series],
        ['Number', context.Number ?? context.ChapterNumber],
        ['Title', context.Title ?? context.ChapterTitle],
        ['TitleSort', context.Title ?? context.ChapterTitle],
        ['Volume', context.Volume]
    ];
    let result = current;
    for (const [field, rawValue] of nextFields) {
        if (rawValue == null || String(rawValue).trim() === '') continue;
        result = setDirectFieldValue(result, field, rawValue);
    }

    if (context.IsSpecial === true || context.Special === true) {
        result = setDirectFieldValue(result, 'Format', 'Special');
    } else if (context.IsSpecial === false || context.Special === false) {
        result = result.replace(/\s*<Format\b[^>]*>[\s\S]*?<\/Format\s*>/i, '')
            .replace(/\s*<Format\b[^>]*\/\s*>/i, '');
    }
    return validateComicInfoXml(result);
}

function normalizeTemplateToken(name) {
    return String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function renderComicInfoTemplate(templateXml, context = {}) {
    const cleanTemplate = validateComicInfoXml(templateXml);
    const normalized = new Map(Object.entries(context || {}).map(([key, value]) => [normalizeTemplateToken(key), value]));
    const aliases = {
        seriesname: 'series',
        chapter: 'chapterlabel',
        chaptername: 'chaptertitle',
        filenamewithoutextension: 'filename'
    };
    return cleanTemplate.replace(/\{\{\s*([A-Za-z][A-Za-z0-9 _.-]*)\s*\}\}/g, (_match, token) => {
        const key = normalizeTemplateToken(token);
        const resolvedKey = aliases[key] || key;
        const value = normalized.has(resolvedKey) ? normalized.get(resolvedKey) : '';
        if (value == null || value === '') return '';
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return escapeXml(value);
    });
}

function createDefaultTemplate() {
    return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n  <Series>{{Series}}</Series>\n  <LocalizedSeries></LocalizedSeries>\n  <Number>{{ChapterNumber}}</Number>\n  <Count></Count>\n  <Volume>{{Volume}}</Volume>\n  <AlternateSeries></AlternateSeries>\n  <AlternateNumber></AlternateNumber>\n  <AlternateCount></AlternateCount>\n  <Title>{{ChapterTitle}}</Title>\n  <Summary></Summary>\n  <SeriesGroup></SeriesGroup>\n  <Publisher></Publisher>\n  <Imprint></Imprint>\n  <Genre></Genre>\n  <Web></Web>\n  <LanguageISO></LanguageISO>\n  <Format>{{Format}}</Format>\n  <BlackAndWhite></BlackAndWhite>\n  <Manga></Manga>\n  <Year></Year>\n  <Month></Month>\n  <Day></Day>\n  <Writer></Writer>\n  <Penciller></Penciller>\n  <Inker></Inker>\n  <Colorist></Colorist>\n  <Letterer></Letterer>\n  <CoverArtist></CoverArtist>\n  <Editor></Editor>\n  <Translator></Translator>\n  <Characters></Characters>\n  <Teams></Teams>\n  <Locations></Locations>\n  <ScanInformation></ScanInformation>\n  <StoryArc></StoryArc>\n  <StoryArcNumber></StoryArcNumber>\n  <AgeRating></AgeRating>\n  <MainCharacterOrTeam></MainCharacterOrTeam>\n  <Tags></Tags>\n  <BookType></BookType>\n  <GTIN></GTIN>\n  <SeriesSort></SeriesSort>\n  <TitleSort></TitleSort>\n  <CommunityRating></CommunityRating>\n  <Review></Review>\n  <Notes></Notes>\n  <PageCount></PageCount>\n  <Pages></Pages>\n</ComicInfo>`;
}

module.exports = {
    FIELD_NAMES, MAX_XML_BYTES, escapeXml, validateComicInfoXml,
    upgradeComicInfoXml, updateComicInfoIdentity, renderComicInfoTemplate, createDefaultTemplate
};
