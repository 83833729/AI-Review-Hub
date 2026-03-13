const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const logger = require('../logger');

/**
 * 各 CLI 的约定技能根目录名（已通过官方文档确认）
 * - `'codex'`: `.agent/skills`
 * - `'gemini'`: `.gemini/skills`
 * - `'claude'`: `.claude/skills`
 */
const CLI_SKILLS_DIR = {
    codex: '.agent/skills',
    gemini: '.gemini/skills',
    claude: '.claude/skills',
};

/** 注册表文件名（隐藏文件） */
const REGISTRY_FILE = '.airh-registry.json';

/**
 * 跨平台 symlink 类型
 * - Windows: `'junction'`（无需管理员权限）
 * - Linux/Mac: `undefined`（默认 dir symlink）
 */
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : undefined;

// ─── 注册表读写 ────────────────────────────────────────────

/**
 * 安全读取注册表文件
 * @param {string} registryPath - 注册表文件绝对路径
 * @returns {Object<string, {source: string, refs: string[], pid: number}>}
 */
function readRegistry(registryPath) {
    try {
        if (fs.existsSync(registryPath)) {
            return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        }
    } catch (e) {
        logger.warn(`[Skills] 注册表读取失败（将重建）: ${e.message}`);
    }
    return {};
}

/**
 * 原子写入注册表文件
 * @param {string} registryPath - 注册表文件绝对路径
 * @param {Object} registry - 注册表数据
 */
function writeRegistry(registryPath, registry) {
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * 安全 unlink（junction/symlink），失败不抛出
 * @param {string} target - junction 路径
 */
function safeUnlink(target) {
    try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
            fs.unlinkSync(target);
        }
    } catch (_) { /* 已不存在或无权限，忽略 */ }
}

/**
 * 带文件锁执行回调（基于 proper-lockfile）
 *
 * 以注册表文件的 .lock 文件作为互斥锁，防止多任务并发读写同一注册表。
 * @param {string} registryPath - 注册表文件路径（必须存在）
 * @param {() => void} fn - 在锁内同步执行的回调
 */
async function withFileLock(registryPath, fn) {
    // 确保注册表文件存在（lockfile 需要锁定一个已存在的文件）
    if (!fs.existsSync(registryPath)) {
        fs.writeFileSync(registryPath, '{}', 'utf-8');
    }
    let release;
    try {
        release = await lockfile.lock(registryPath, {
            retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
        });
        fn();
    } finally {
        if (release) {
            try { await release(); } catch (_) { /* ignore */ }
        }
    }
}

// ─── 核心 API ──────────────────────────────────────────────

/**
 * 为任务注入外部技能（方案 R：一级目录 + 注册表引用计数）
 *
 * junction 直接创建在 `skillsRoot` 一级目录下，通过 `.airh-registry.json`
 * 维护引用计数。多任务共享同一 junction，最后一个任务清理时才 unlink。
 *
 * @param {'codex'|'gemini'|'claude'} cli - 目标 CLI
 * @param {string} workdir - 工作目录绝对路径
 * @param {string} skillsDir - 外部技能目录绝对路径
 * @param {string} taskId - 任务 ID
 * @returns {Promise<{taskId: string, cli: string, workdir: string, injectedSkills: string[]}|null>}
 *   注入句柄（用于 cleanupSkills），无技能注入时返回 null
 */
async function setupSkills(cli, workdir, skillsDir, taskId) {
    if (!skillsDir || !workdir || !taskId) return null;

    // 校验 cli
    if (!CLI_SKILLS_DIR[cli]) {
        logger.warn(`[Skills] 不支持的 CLI: ${cli}`);
        return null;
    }

    // 校验 skillsDir 存在性 + 是目录
    const resolvedSkillsDir = path.resolve(skillsDir);
    if (!fs.existsSync(resolvedSkillsDir) || !fs.statSync(resolvedSkillsDir).isDirectory()) {
        logger.warn(`[Skills] skillsDir 无效: ${resolvedSkillsDir}`);
        return null;
    }

    const skillsRoot = path.join(path.resolve(workdir), CLI_SKILLS_DIR[cli]);
    const registryPath = path.join(skillsRoot, REGISTRY_FILE);

    // 确保 skills 根目录存在
    fs.mkdirSync(skillsRoot, { recursive: true });

    const injected = [];

    await withFileLock(registryPath, () => {
        const registry = readRegistry(registryPath);

        // 扫描 skillsDir 下每个有效技能子目录
        for (const entry of fs.readdirSync(resolvedSkillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;

            const skillName = entry.name;
            const sourceDir = path.join(resolvedSkillsDir, skillName);

            // 跳过无 SKILL.md 的无效目录
            if (!fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
                logger.debug(`[Skills] 跳过无效技能: ${skillName}（无 SKILL.md）`);
                continue;
            }

            const targetPath = path.join(skillsRoot, skillName);
            const targetExists = fs.existsSync(targetPath);

            // 冲突检测：目录已存在 + 不在注册表中 → 原生技能，跳过
            if (targetExists && !registry[skillName]) {
                logger.warn(`[Skills] [${taskId}] 跳过: ${skillName} 已存在（原生技能）`);
                continue;
            }

            if (!registry[skillName]) {
                // 首次注入：创建 junction + 注册
                try {
                    fs.symlinkSync(sourceDir, targetPath, SYMLINK_TYPE);
                    registry[skillName] = {
                        source: sourceDir,
                        refs: [taskId],
                        pid: process.pid,
                    };
                    injected.push(skillName);
                    logger.info(`[Skills] [${taskId}] Junction: ${skillName} → ${sourceDir}`);
                } catch (e) {
                    logger.warn(`[Skills] [${taskId}] Junction 创建失败: ${skillName}: ${e.message}`);
                }
            } else {
                // 修复#2：同名技能不同 source → 冲突，跳过并警告
                const existingSource = path.resolve(registry[skillName].source);
                if (existingSource !== path.resolve(sourceDir)) {
                    logger.warn(`[Skills] [${taskId}] 跳过: ${skillName} source 冲突（已有: ${existingSource}，新: ${sourceDir}）`);
                    continue;
                }

                // 修复#4：复用前校验 junction 状态
                if (targetExists) {
                    // junction 存在：校验指向是否正确
                    try {
                        const actual = fs.readlinkSync(targetPath);
                        if (path.resolve(actual) !== path.resolve(sourceDir)) {
                            logger.warn(`[Skills] [${taskId}] junction ${skillName} 指向已变（期望: ${sourceDir}，实际: ${actual}），重建`);
                            safeUnlink(targetPath);
                            fs.symlinkSync(sourceDir, targetPath, SYMLINK_TYPE);
                        }
                    } catch (_) { /* readlink 失败说明不是 symlink，跳过 */ }
                } else {
                    // 注册表有记录但磁盘无 junction：自愈重建
                    try {
                        fs.symlinkSync(sourceDir, targetPath, SYMLINK_TYPE);
                        logger.info(`[Skills] [${taskId}] 自愈重建 junction: ${skillName} → ${sourceDir}`);
                    } catch (e) {
                        logger.warn(`[Skills] [${taskId}] 自愈重建失败: ${skillName}: ${e.message}`);
                    }
                }

                // 追加引用
                if (!registry[skillName].refs.includes(taskId)) {
                    registry[skillName].refs.push(taskId);
                }
                injected.push(skillName);
                logger.debug(`[Skills] [${taskId}] 追加引用: ${skillName} (refs: ${registry[skillName].refs.length})`);
            }
        }

        writeRegistry(registryPath, registry);
    });

    if (injected.length === 0) return null;

    logger.info(`[Skills] [${taskId}] 已注入 ${injected.length} 个技能到 ${skillsRoot}`);
    return { taskId, cli, workdir: path.resolve(workdir), injectedSkills: injected };
}

/**
 * 清理单个任务的注入技能（引用计数递减，归零时 unlink junction）
 *
 * 此函数是幂等的，重复调用不会报错。
 * @param {{taskId: string, cli: string, workdir: string}|string|null} handle
 *   - 对象形式: setupSkills 返回的句柄
 *   - 字符串形式: 已废弃的 isolationDir 路径（向后兼容）
 *   - null: 无操作
 */
async function cleanupSkills(handle) {
    if (!handle) return;

    // 向后兼容：旧版传入 isolationDir 字符串
    if (typeof handle === 'string') {
        logger.debug(`[Skills] 旧版 isolationDir 清理: ${handle}`);
        _legacyCleanup(handle);
        return;
    }

    const { taskId, cli, workdir } = handle;
    if (!taskId || !cli || !workdir) return;

    const skillsRoot = path.join(path.resolve(workdir), CLI_SKILLS_DIR[cli]);
    const registryPath = path.join(skillsRoot, REGISTRY_FILE);

    if (!fs.existsSync(registryPath)) return;

    try {
        await withFileLock(registryPath, () => {
            const registry = readRegistry(registryPath);

            for (const [name, info] of Object.entries(registry)) {
                // 移除当前 taskId 的引用
                info.refs = info.refs.filter(id => id !== taskId);

                if (info.refs.length === 0) {
                    // 修复#4：先 unlink，确认成功后再删注册表条目
                    const junctionPath = path.join(skillsRoot, name);
                    const unlinkOk = _safeUnlinkVerified(junctionPath);
                    if (unlinkOk) {
                        delete registry[name];
                        logger.info(`[Skills] [${taskId}] 清理 junction: ${name}`);
                    } else {
                        logger.warn(`[Skills] [${taskId}] junction 删除失败，保留注册表: ${name}`);
                    }
                }
            }

            // 注册表为空时删除文件
            if (Object.keys(registry).length === 0) {
                try { fs.unlinkSync(registryPath); } catch (_) { /* ignore */ }
                logger.debug(`[Skills] 注册表已空，已删除: ${registryPath}`);
            } else {
                writeRegistry(registryPath, registry);
            }
        });
    } catch (e) {
        logger.warn(`[Skills] [${taskId}] 清理失败: ${e.message}`);
    }
}

/**
 * 启动时 GC：基于注册表清理孤儿 junction
 *
 * 检查逻辑：
 * 1. 读取每个 CLI skills 目录下的 `.airh-registry.json`
 * 2. 对每个注册条目，检查 `refs` 中的 taskId 是否仍存活
 * 3. 检查 `pid` 是否仍存活
 * 4. 如果 refs 全部失效且 pid 已死 → unlink junction + 移除注册表条目
 * 5. 自愈：注册表有记录但磁盘无目录 → 删注册表条目
 *
 * @param {string[]} workdirs - 需要扫描的工作目录列表
 * @param {(taskId: string) => boolean} [isTaskAlive] - 判断 taskId 是否仍存活的回调
 */
async function gcOrphanedSkills(workdirs, isTaskAlive) {
    let cleaned = 0;

    for (const workdir of workdirs) {
        for (const cliDir of Object.values(CLI_SKILLS_DIR)) {
            const skillsRoot = path.join(path.resolve(workdir), cliDir);
            const registryPath = path.join(skillsRoot, REGISTRY_FILE);

            // 修复#6：无论是否有注册表，都要清理旧版隔离目录
            _legacyGc(skillsRoot);

            if (!fs.existsSync(registryPath)) continue;

            try {
                // 修复#1：GC 统一走文件锁，防止并发读写覆盖
                await withFileLock(registryPath, () => {
                    const registry = readRegistry(registryPath);
                    let modified = false;

                    for (const [name, info] of Object.entries(registry)) {
                        const junctionPath = path.join(skillsRoot, name);

                        // 自愈：注册表有记录但磁盘已无 junction
                        if (!fs.existsSync(junctionPath)) {
                            delete registry[name];
                            modified = true;
                            cleaned++;
                            logger.debug(`[Skills] GC 自愈: ${name}（磁盘已无，清理注册表）`);
                            continue;
                        }

                        // 修复#3：过滤死亡 taskId 后标记 modified，确保持久化
                        if (isTaskAlive) {
                            const before = info.refs.length;
                            info.refs = info.refs.filter(id => isTaskAlive(id));
                            if (info.refs.length !== before) modified = true;
                        }

                        // 检查 pid 是否存活
                        const pidAlive = _isProcessAlive(info.pid);

                        // refs 已空 + pid 已死 → 孤儿
                        if (info.refs.length === 0 && !pidAlive) {
                            safeUnlink(junctionPath);
                            delete registry[name];
                            modified = true;
                            cleaned++;
                            logger.info(`[Skills] GC 清理孤儿 junction: ${name}`);
                        }
                    }

                    if (modified) {
                        if (Object.keys(registry).length === 0) {
                            try { fs.unlinkSync(registryPath); } catch (_) { /* ignore */ }
                        } else {
                            writeRegistry(registryPath, registry);
                        }
                    }
                });
            } catch (e) {
                logger.warn(`[Skills] GC 扫描失败 ${skillsRoot}: ${e.message}`);
            }
        }
    }

    if (cleaned > 0) {
        logger.info(`[Skills] GC: 清理了 ${cleaned} 个孤儿记录/junction`);
    }
}

// ─── 内部工具 ──────────────────────────────────────────────

/**
 * 安全 unlink 并验证结果
 * @param {string} target - junction 路径
 * @returns {boolean} 是否成功删除（目标不存在也视为成功）
 */
function _safeUnlinkVerified(target) {
    try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
            fs.unlinkSync(target);
        }
    } catch (e) {
        // ENOENT = 已不存在，视为成功
        if (e.code !== 'ENOENT') return false;
    }
    // 验证确实已删除
    return !fs.existsSync(target);
}

/**
 * 检查进程是否存活
 * @param {number} pid - 进程 ID
 * @returns {boolean}
 */
function _isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * 向后兼容：清理旧版隔离目录（.airh-{taskId}/ 二级目录结构）
 * @param {string} isolationDir - 旧版隔离目录路径
 */
function _legacyCleanup(isolationDir) {
    try {
        for (const entry of fs.readdirSync(isolationDir)) {
            const jp = path.join(isolationDir, entry);
            try {
                if (fs.lstatSync(jp).isSymbolicLink()) fs.unlinkSync(jp);
            } catch (_) { /* ignore */ }
        }
        fs.rmdirSync(isolationDir);
        logger.info(`[Skills] 旧版清理完成: ${isolationDir}`);
    } catch (e) {
        logger.warn(`[Skills] 旧版清理失败: ${isolationDir}: ${e.message}`);
    }
}

/** 隔离目录前缀（向后兼容 GC 用） */
const ISOLATION_PREFIX = '.airh-';

/**
 * 向后兼容：扫描旧版 .airh-{taskId} 隔离目录并清理
 * @param {string} skillsRoot - CLI skills 根目录
 */
function _legacyGc(skillsRoot) {
    if (!fs.existsSync(skillsRoot)) return;

    for (const entry of fs.readdirSync(skillsRoot)) {
        if (!entry.startsWith(ISOLATION_PREFIX)) continue;

        const orphanDir = path.join(skillsRoot, entry);
        try {
            const stat = fs.lstatSync(orphanDir);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(orphanDir);
                continue;
            }
            if (!stat.isDirectory()) continue;

            for (const child of fs.readdirSync(orphanDir)) {
                const jp = path.join(orphanDir, child);
                try {
                    if (fs.lstatSync(jp).isSymbolicLink()) fs.unlinkSync(jp);
                } catch (_) { /* ignore */ }
            }
            fs.rmdirSync(orphanDir);
            logger.info(`[Skills] 旧版 GC 清理: ${orphanDir}`);
        } catch (_) { /* ignore */ }
    }
}

module.exports = { setupSkills, cleanupSkills, gcOrphanedSkills, ISOLATION_PREFIX };
