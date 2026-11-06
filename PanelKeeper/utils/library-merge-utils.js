'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

async function pathExists(target) { try { await fs.access(target); return true; } catch (_) { return false; } }
async function moveFile(source, target) {
    try { await fs.rename(source, target); }
    catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fs.copyFile(source, target, fsSync.constants.COPYFILE_EXCL);
        await fs.unlink(source);
    }
}

function uniqueMergedPath(destinationPath) {
    const directory = path.dirname(destinationPath);
    const extension = path.extname(destinationPath);
    const stem = path.basename(destinationPath, extension);
    for (let index = 1; index <= 9999; index++) {
        const suffix = index === 1 ? ' [merged]' : ` [merged ${index}]`;
        const candidate = path.join(directory, `${stem}${suffix}${extension}`);
        if (!fsSync.existsSync(candidate)) return candidate;
    }
    throw new Error(`Could not create a unique merge name for ${path.basename(destinationPath)}.`);
}

async function mergeDirectoryContents(sourceRoot, targetRoot) {
    const source = path.resolve(sourceRoot);
    const target = path.resolve(targetRoot);
    if (source === target) throw new Error('Source and destination folders are the same.');
    if (!(await pathExists(source)) || !(await fs.stat(source)).isDirectory()) throw new Error('The source folder is not an accessible directory.');
    await fs.mkdir(target, { recursive: true });
    if (!(await fs.stat(target)).isDirectory()) throw new Error('The destination path exists but is not a directory.');

    const pathMap = new Map();
    const createdDirectories = [];
    const movedFiles = [];
    let moved = 0;
    let renamed = 0;

    async function ensureTrackedDirectory(directory) {
        if (await pathExists(directory)) return;
        await fs.mkdir(directory, { recursive: true });
        createdDirectories.push(directory);
    }

    async function visit(sourceDir, targetDir) {
        await ensureTrackedDirectory(targetDir);
        pathMap.set(path.resolve(sourceDir), path.resolve(targetDir));
        const entries = await fs.readdir(sourceDir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            let targetPath = path.join(targetDir, entry.name);
            const sourceStat = await fs.lstat(sourcePath);
            if (sourceStat.isSymbolicLink()) throw new Error(`Merge stopped because a symbolic link was found: ${sourcePath}`);

            if (sourceStat.isDirectory()) {
                if (await pathExists(targetPath)) {
                    const targetStat = await fs.lstat(targetPath);
                    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
                        targetPath = uniqueMergedPath(targetPath);
                        renamed++;
                    }
                }
                await visit(sourcePath, targetPath);
                await fs.rm(sourcePath, { recursive: true, force: true });
                continue;
            }
            if (!sourceStat.isFile()) continue;

            if (await pathExists(targetPath)) {
                targetPath = uniqueMergedPath(targetPath);
                renamed++;
            }
            await moveFile(sourcePath, targetPath);
            pathMap.set(path.resolve(sourcePath), path.resolve(targetPath));
            movedFiles.push({ sourcePath: path.resolve(sourcePath), targetPath: path.resolve(targetPath) });
            moved++;
        }
    }

    try {
        await visit(source, target);
        await fs.rm(source, { recursive: true, force: true });
        return { source, target, pathMap, createdDirectories, movedFiles, moved, renamed, merged: true };
    } catch (error) {
        await rollbackDirectoryMerge({ pathMap, createdDirectories, movedFiles, source });
        throw error;
    }
}

async function rollbackDirectoryMerge(result) {
    if (!result || !Array.isArray(result.movedFiles)) return;
    for (const item of [...result.movedFiles].reverse()) {
        if (!(await pathExists(item.targetPath))) continue;
        await fs.mkdir(path.dirname(item.sourcePath), { recursive: true });
        await moveFile(item.targetPath, item.sourcePath);
    }
    for (const directory of [...(result.createdDirectories || [])].sort((a, b) => b.length - a.length)) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    if (result.source && !(await pathExists(result.source))) await fs.mkdir(result.source, { recursive: true });
}

function mapMergedPath(value, pathMap) {
    const resolved = path.resolve(String(value || ''));
    if (!pathMap || !pathMap.size) return resolved;
    const exact = pathMap.get(resolved);
    if (exact) return exact;
    let bestSource = '';
    let bestTarget = '';
    for (const [source, target] of pathMap) {
        const prefix = `${path.resolve(source)}${path.sep}`;
        if (resolved.startsWith(prefix) && source.length > bestSource.length) {
            bestSource = path.resolve(source);
            bestTarget = path.resolve(target);
        }
    }
    return bestSource ? path.resolve(bestTarget, path.relative(bestSource, resolved)) : resolved;
}

module.exports = { uniqueMergedPath, mergeDirectoryContents, rollbackDirectoryMerge, mapMergedPath };
