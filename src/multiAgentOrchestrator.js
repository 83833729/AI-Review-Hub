const logger = require('./logger');

/** 串行讨论的上下文字符预算（超过后截断历史） */
const MAX_CONTEXT_CHARS = 8000;

/**
 * 多智能体编排器
 *
 * 负责"讨论"（串行）和"群聊"（并行）两种多 CLI 会话的状态机推进、
 * prompt 构建、失败策略和取消机制。
 *
 * 设计原则：仅调用 SessionManager 暴露的公共接口（createTempSession / executePrompt），
 * 不侵入其内部逻辑。
 *
 * 会话记录由调用方（API 层）在调度前同步创建，编排器通过 conversationId 关联。
 */
class MultiAgentOrchestrator {
    /**
     * @param {import('./taskStore')} store - 数据存储
     * @param {import('./sessionManager')} sessionManager - 会话管理器
     * @param {object} [options]
     * @param {number} [options.promptTimeout=600] - 单轮 prompt 超时秒数
     */
    constructor(store, sessionManager, options = {}) {
        this.store = store;
        this.sessionManager = sessionManager;
        this.promptTimeout = (options.promptTimeout || 600) * 1000;

        /**
         * 进行中的会话映射（用于取消）
         * conversationId → { cancelled: boolean, tempSessions: Array<{ adapter, acpSessionId }> }
         * @type {Map<string, { cancelled: boolean, tempSessions: Array<{ adapter: any, acpSessionId: string }> }>}
         */
        this._running = new Map();
    }

    // ==================== 讨论模式（串行） ====================

    /**
     * 执行多 CLI 串行讨论（会话记录已由调用方创建）
     *
     * @param {string} conversationId - 已创建的会话 ID
     * @param {object} [callbacks]
     * @param {Function} [callbacks.onMessage] - (convId, cli, role, content, seq) => void
     * @param {Function} [callbacks.onParticipant] - (convId, cli, status) => void
     * @param {Function} [callbacks.onStatus] - (convId, status, type) => void
     * @returns {Promise<object>} 完成的会话记录
     */
    async runDiscussion(conversationId, callbacks = {}) {
        const conv = this.store.getConversation(conversationId);
        if (!conv) throw new Error(`会话 ${conversationId} 不存在`);

        const participants = this.store.getParticipants(conversationId);

        // 注册运行映射
        this._running.set(conversationId, { cancelled: false, tempSessions: [] });

        // idle → running
        this.store.updateConversationStatus(conversationId, 'running');
        callbacks.onStatus?.(conversationId, 'running', 'discussion');

        // 插入用户原始问题（原子 seq）
        const userMsg = this.store.addConversationMessageAtomic({
            conversationId, cli: 'user', role: 'user', content: conv.question,
        });
        callbacks.onMessage?.(conversationId, 'user', 'user', conv.question, userMsg.seq);

        /** 累积上下文（供后续 CLI 查看） */
        const history = [];
        let hasError = false;

        try {
            for (let i = 0; i < participants.length; i++) {
                const p = participants[i];
                const runState = this._running.get(conversationId);

                // 检查取消
                if (runState?.cancelled) {
                    this.store.updateParticipantStatus(p.id, 'cancelled');
                    callbacks.onParticipant?.(conversationId, p.cli, 'cancelled');
                    continue;
                }

                // participant → running
                this.store.updateParticipantStatus(p.id, 'running');
                callbacks.onParticipant?.(conversationId, p.cli, 'running');

                let tempSession = null;
                try {
                    const isLast = i === participants.length - 1;
                    const prompt = this._buildDiscussionPrompt(conv.question, history, isLast, p.cli);

                    tempSession = await this.sessionManager.createTempSession(
                        p.cli, conv.workdir, conv.sandbox,
                    );

                    // 注册到活跃列表
                    if (runState) runState.tempSessions.push(tempSession);

                    const result = await this.sessionManager.executePrompt({
                        adapter: tempSession.adapter,
                        acpSessionId: tempSession.acpSessionId,
                        message: prompt,
                        timeoutMs: this.promptTimeout,
                    });

                    // 再次检查取消（prompt 执行期间可能被取消）
                    if (runState?.cancelled) {
                        this.store.updateParticipantStatus(p.id, 'cancelled');
                        callbacks.onParticipant?.(conversationId, p.cli, 'cancelled');
                        continue;
                    }

                    // 记录回答（原子 seq）
                    const msg = this.store.addConversationMessageAtomic({
                        conversationId, participantId: p.id, cli: p.cli,
                        role: 'assistant', content: result.content,
                    });
                    callbacks.onMessage?.(conversationId, p.cli, 'assistant', result.content, msg.seq);

                    // 写入追踪记录（prompt_input + thinking）
                    this.store.createTrace(msg.id, prompt, result.thinking);

                    // 累积上下文
                    history.push({ cli: p.cli, content: result.content });

                    // participant → done
                    this.store.updateParticipantStatus(p.id, 'done');
                    callbacks.onParticipant?.(conversationId, p.cli, 'done');
                } catch (err) {
                    hasError = true;
                    const errMsg = err.message || String(err);
                    logger.error(`[Orchestrator] 讨论 ${conversationId} CLI ${p.cli} 失败: ${errMsg}`);

                    // 记录错误消息
                    const errMsgRecord = this.store.addConversationMessageAtomic({
                        conversationId, participantId: p.id, cli: p.cli,
                        role: 'assistant', content: `[错误] ${errMsg}`,
                    });
                    callbacks.onMessage?.(conversationId, p.cli, 'assistant', `[错误] ${errMsg}`, errMsgRecord.seq);

                    // participant → error（跳过该 CLI 继续）
                    this.store.updateParticipantStatus(p.id, 'error', { error: errMsg });
                    callbacks.onParticipant?.(conversationId, p.cli, 'error');
                } finally {
                    // 释放临时 session
                    if (tempSession) this._releaseTempSession(tempSession);
                }
            }

            // 汇总
            const lastSuccess = history[history.length - 1];
            const summary = lastSuccess?.content || null;
            const finalStatus = this._running.get(conversationId)?.cancelled
                ? 'cancelled'
                : hasError ? 'partial' : 'completed';

            this.store.updateConversationStatus(conversationId, finalStatus, { summary });
            callbacks.onStatus?.(conversationId, finalStatus, 'discussion');

            return this.store.getConversation(conversationId);
        } catch (err) {
            this.store.updateConversationStatus(conversationId, 'failed', { error: err.message });
            callbacks.onStatus?.(conversationId, 'failed', 'discussion');
            throw err;
        } finally {
            this._running.delete(conversationId);
        }
    }

    // ==================== 群聊模式（并行） ====================

    /**
     * 执行多 CLI 并行群聊（会话记录已由调用方创建）
     *
     * @param {string} conversationId - 已创建的会话 ID
     * @param {object} [callbacks] - 同 runDiscussion
     * @returns {Promise<object>} 完成的会话记录
     */
    async runGroupChat(conversationId, callbacks = {}) {
        const conv = this.store.getConversation(conversationId);
        if (!conv) throw new Error(`会话 ${conversationId} 不存在`);

        const participants = this.store.getParticipants(conversationId);

        this._running.set(conversationId, { cancelled: false, tempSessions: [] });

        // idle → running
        this.store.updateConversationStatus(conversationId, 'running');
        callbacks.onStatus?.(conversationId, 'running', 'group_chat');

        // 插入用户原始问题（原子 seq）
        const userMsg = this.store.addConversationMessageAtomic({
            conversationId, cli: 'user', role: 'user', content: conv.question,
        });
        callbacks.onMessage?.(conversationId, 'user', 'user', conv.question, userMsg.seq);

        try {
            // 并行执行所有 CLI
            const results = await Promise.allSettled(
                participants.map(async (p) => {
                    const runState = this._running.get(conversationId);

                    // 检查取消
                    if (runState?.cancelled) {
                        this.store.updateParticipantStatus(p.id, 'cancelled');
                        callbacks.onParticipant?.(conversationId, p.cli, 'cancelled');
                        return;
                    }

                    // participant → running
                    this.store.updateParticipantStatus(p.id, 'running');
                    callbacks.onParticipant?.(conversationId, p.cli, 'running');

                    const tempSession = await this.sessionManager.createTempSession(
                        p.cli, conv.workdir, conv.sandbox,
                    );

                    // 注册到活跃列表
                    if (runState) runState.tempSessions.push(tempSession);

                    try {
                        const result = await this.sessionManager.executePrompt({
                            adapter: tempSession.adapter,
                            acpSessionId: tempSession.acpSessionId,
                            message: conv.question,
                            timeoutMs: this.promptTimeout,
                        });

                        // 再次检查取消
                        if (runState?.cancelled) {
                            this.store.updateParticipantStatus(p.id, 'cancelled');
                            callbacks.onParticipant?.(conversationId, p.cli, 'cancelled');
                            return;
                        }

                        // 原子 seq 写入消息
                        const msg = this.store.addConversationMessageAtomic({
                            conversationId, participantId: p.id, cli: p.cli,
                            role: 'assistant', content: result.content,
                        });
                        callbacks.onMessage?.(conversationId, p.cli, 'assistant', result.content, msg.seq);

                        // 写入追踪记录（prompt_input + thinking）
                        this.store.createTrace(msg.id, conv.question, result.thinking);

                        this.store.updateParticipantStatus(p.id, 'done');
                        callbacks.onParticipant?.(conversationId, p.cli, 'done');
                    } finally {
                        // 释放临时 session
                        this._releaseTempSession(tempSession);
                    }
                }),
            );

            // 汇总：统计成功/失败数
            const doneCount = results.filter(r => r.status === 'fulfilled').length;
            const errorCount = results.filter(r => r.status === 'rejected').length;

            // 处理失败的 participant
            for (let i = 0; i < results.length; i++) {
                if (results[i].status === 'rejected') {
                    const p = participants[i];
                    const errMsg = results[i].reason?.message || String(results[i].reason);
                    logger.error(`[Orchestrator] 群聊 ${conversationId} CLI ${p.cli} 失败: ${errMsg}`);

                    const errMsgRecord = this.store.addConversationMessageAtomic({
                        conversationId, participantId: p.id, cli: p.cli,
                        role: 'assistant', content: `[错误] ${errMsg}`,
                    });
                    callbacks.onMessage?.(conversationId, p.cli, 'assistant', `[错误] ${errMsg}`, errMsgRecord.seq);

                    this.store.updateParticipantStatus(p.id, 'error', { error: errMsg });
                    callbacks.onParticipant?.(conversationId, p.cli, 'error');
                }
            }

            const finalStatus = this._running.get(conversationId)?.cancelled
                ? 'cancelled'
                : errorCount > 0 ? (doneCount > 0 ? 'partial' : 'failed') : 'completed';

            this.store.updateConversationStatus(conversationId, finalStatus);
            callbacks.onStatus?.(conversationId, finalStatus, 'group_chat');

            return this.store.getConversation(conversationId);
        } catch (err) {
            this.store.updateConversationStatus(conversationId, 'failed', { error: err.message });
            callbacks.onStatus?.(conversationId, 'failed', 'group_chat');
            throw err;
        } finally {
            this._running.delete(conversationId);
        }
    }

    // ==================== 取消 ====================

    /**
     * 取消进行中的会话
     * @param {string} conversationId
     */
    async cancelConversation(conversationId) {
        const conv = this.store.getConversation(conversationId);
        if (!conv) throw new Error(`会话 ${conversationId} 不存在`);

        if (['completed', 'partial', 'failed', 'cancelled'].includes(conv.status)) {
            throw new Error(`会话已处于终态: ${conv.status}`);
        }

        const runState = this._running.get(conversationId);
        if (runState) {
            runState.cancelled = true;
            // 取消所有 临时 session 上正在执行的 prompt
            for (const { adapter, acpSessionId } of runState.tempSessions) {
                try { await adapter.cancel(acpSessionId); } catch (_) { }
            }
        }

        // 标记所有 pending/running 的 participant 为 cancelled
        const participants = this.store.getParticipants(conversationId);
        for (const p of participants) {
            if (['pending', 'running'].includes(p.status)) {
                this.store.updateParticipantStatus(p.id, 'cancelled');
            }
        }

        this.store.updateConversationStatus(conversationId, 'cancelled');
    }

    // ==================== 内部方法 ====================

    /**
     * 释放临时 ACP session
     *
     * 当前 ACP SDK 不支持单 session 关闭，所以仅从活跃列表移除。
     * 底层连接会在没有活跃 session 时由 SessionManager 的空闲超时机制回收。
     * @param {{ adapter: any, acpSessionId: string }} tempSession
     */
    _releaseTempSession(tempSession) {
        // 从所有运行映射的 tempSessions 中移除
        for (const [, state] of this._running) {
            state.tempSessions = state.tempSessions.filter(
                s => s.acpSessionId !== tempSession.acpSessionId,
            );
        }
        logger.info(`[Orchestrator] 临时 session 已标记释放: ${tempSession.acpSessionId}`);
    }

    /**
     * 构建讨论模式的 prompt
     *
     * 含上下文预算控制：历史超过 MAX_CONTEXT_CHARS 时截断为摘要。
     *
     * @param {string} question - 原始问题
     * @param {Array<{ cli: string, content: string }>} history - 前面 CLI 的回答
     * @param {boolean} isLast - 是否最后一个 CLI
     * @param {string} cli - 当前 CLI
     * @returns {string} 构建的 prompt
     */
    _buildDiscussionPrompt(question, history, isLast, cli) {
        const parts = [];

        parts.push(`## 原始问题\n${question}`);

        if (history.length > 0) {
            let historyText = history
                .map(h => `### ${h.cli} 的回答\n${h.content}`)
                .join('\n\n');

            // 预算控制：超出限制时只保留最近 1 条完整 + 前面的摘要
            if (historyText.length > MAX_CONTEXT_CHARS && history.length > 1) {
                const recent = history[history.length - 1];
                const earlier = history.slice(0, -1);
                const summaryText = earlier
                    .map(h => `- ${h.cli}: ${h.content.substring(0, 200)}...`)
                    .join('\n');
                historyText = `### 前面的讨论（摘要）\n${summaryText}\n\n### ${recent.cli} 的最近回答\n${recent.content}`;
            }

            parts.push(`## 之前的讨论\n${historyText}`);
        }

        if (isLast) {
            parts.push(`## 你的任务\n你是 ${cli}。请综合以上所有讨论，给出最终总结答案。要求：\n1. 综合各方观点\n2. 指出共识和分歧\n3. 给出你的最终结论`);
        } else if (history.length === 0) {
            parts.push(`## 你的任务\n你是 ${cli}。请就以上问题给出你的详细回答。`);
        } else {
            parts.push(`## 你的任务\n你是 ${cli}。请在前面讨论的基础上，补充你的观点或不同看法。`);
        }

        return parts.join('\n\n');
    }

    /** 获取进行中的会话数 */
    getRunningCount() { return this._running.size; }
}

module.exports = MultiAgentOrchestrator;
