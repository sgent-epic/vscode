/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import type { IAgentServerToolHost, IAgentServerToolInvocation } from '../../common/agentServerTools.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { buildChatUri, MessageKind, SessionStatus, type ToolDefinition } from '../../common/state/sessionState.js';
import { AgentHostStateManager } from '../../node/agentHostStateManager.js';
import type { IClaudeAgentSdkService } from '../../node/claude/claudeAgentSdkService.js';
import { ClaudeMapperState, mapSDKMessageToAgentSignals } from '../../node/claude/claudeMapSessionEvents.js';
import { SubagentRegistry } from '../../node/claude/claudeSubagentRegistry.js';
import { AgentServerToolHost, type IServerToolExecutionContext } from '../../node/shared/agentServerToolHost.js';
import { makeContentBlockStartToolUse, makeContentBlockStop, makeStreamEvent } from './claudeMapSessionEventsTestUtils.js';
import {
	buildServerToolMcpServer,
	CLAUDE_SERVER_TOOL_MCP_SERVER_NAME,
	extractServerToolName,
	serverToolAllowList,
} from '../../node/claude/claudeServerToolMcpServer.js';

interface RecordedTool {
	name: string;
	handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
}

function makeSdk(): { sdk: IClaudeAgentSdkService; recorded: RecordedTool[] } {
	const recorded: RecordedTool[] = [];
	const sdk = {
		createSdkMcpServer: async (options: { name: string }) =>
			({ name: options.name, instance: { __fake: true } } as unknown as McpSdkServerConfigWithInstance),
		tool: async (name: string, _desc: string, _schema: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>) => {
			const t = { name, handler };
			recorded.push(t);
			return t as unknown as ReturnType<IClaudeAgentSdkService['tool']>;
		},
	} as unknown as IClaudeAgentSdkService;
	return { sdk, recorded };
}

const fakeToolDefinitions: readonly ToolDefinition[] = [
	{ name: 'serverToolA', description: 'A', inputSchema: { type: 'object', properties: {} } },
	{ name: 'serverToolB', description: 'B', inputSchema: { type: 'object', properties: {} } },
];

class FakeServerToolHost implements IAgentServerToolHost {
	readonly definitions: readonly ToolDefinition[] = fakeToolDefinitions;
	readonly toolNames: readonly string[] = fakeToolDefinitions.map(def => def.name);
	readonly executions: Array<{ chatUri: string; toolName: string; rawArgs: unknown; invocation?: IAgentServerToolInvocation }> = [];
	result = 'ok';
	error: Error | undefined;

	advertise(): void { }

	getDefinitionsForSession(): readonly ToolDefinition[] { return this.definitions; }

	canRequireConfirmation(_toolName: string): boolean { return false; }

	requiresConfirmation(_sessionUri: string, _toolName: string): boolean { return false; }

	executeTool(chatUri: string, toolName: string, rawArgs: unknown, invocation?: IAgentServerToolInvocation): string {
		this.executions.push({ chatUri, toolName, rawArgs, ...(invocation ? { invocation } : {}) });
		if (this.error) {
			throw this.error;
		}
		return this.result;
	}
}

suite('claudeServerToolMcpServer / buildServerToolMcpServer', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const chatUri = buildChatUri('claude:/server-tool-session', 'peer');

	test('registers every server tool on the server-tool MCP server', async () => {
		const { sdk, recorded } = makeSdk();
		const host = new FakeServerToolHost();
		const server = await buildServerToolMcpServer(host, chatUri, sdk);
		assert.deepStrictEqual({
			serverName: server.name,
			toolNames: recorded.map(t => t.name).sort(),
		}, {
			serverName: CLAUDE_SERVER_TOOL_MCP_SERVER_NAME,
			toolNames: [...host.toolNames].sort(),
		});
	});

	test('handler executes in-process against the host and returns its text result', async () => {
		const { sdk, recorded } = makeSdk();
		const host = new FakeServerToolHost();
		host.result = 'listed 2 comments';
		await buildServerToolMcpServer(host, chatUri, sdk);

		const handler = recorded.find(t => t.name === 'serverToolA')!.handler;
		const result = await handler({ foo: 'bar' }, undefined);

		assert.deepStrictEqual({
			executions: host.executions,
			result,
		}, {
			executions: [{ chatUri, toolName: 'serverToolA', rawArgs: { foo: 'bar' } }],
			result: { content: [{ type: 'text', text: 'listed 2 comments' }] },
		});
	});

	test('handler surfaces host failures as an isError result', async () => {
		const { sdk, recorded } = makeSdk();
		const host = new FakeServerToolHost();
		host.error = new Error('boom');
		await buildServerToolMcpServer(host, chatUri, sdk);

		const result = await recorded[0]!.handler({}, undefined);
		assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'boom' }], isError: true });
	});

	test('forwards SDK call identity and the registered transport name rather than model arguments', async () => {
		const { sdk, recorded } = makeSdk();
		const host = new FakeServerToolHost();
		await buildServerToolMcpServer(host, chatUri, sdk);
		const rawArgs = { toolCallId: 'forged', toolName: 'forged', chatUri: 'forged' };
		await recorded[0].handler(rawArgs, { _meta: { 'claudecode/toolUseId': 'native-first-call' } });
		await recorded[0].handler(rawArgs, { _meta: { 'claudecode/toolUseId': '' } });

		assert.deepStrictEqual(host.executions, [
			{
				chatUri, toolName: 'serverToolA', rawArgs,
				invocation: { toolCallId: 'native-first-call', toolName: 'mcp__host__serverToolA' },
			},
			{ chatUri, toolName: 'serverToolA', rawArgs },
		]);
	});

	test('the first streamed native tool callback matches the initial server definitions and exact chat', async () => {
		const { sdk, recorded } = makeSdk();
		const log = new NullLogService();
		const manager = disposables.add(new AgentHostStateManager(log));
		const sessionUri = 'claude:/server-tool-session';
		manager.createSession({
			resource: sessionUri, provider: 'claude', title: 'First request', status: SessionStatus.Idle,
			createdAt: '2026-09-06T00:00:00Z', modifiedAt: '2026-09-06T00:00:00Z',
		});
		manager.addChat(sessionUri, chatUri);
		const receipts: Array<IServerToolExecutionContext['invocation']> = [];
		const host = new AgentServerToolHost(manager, [{
			definitions: [fakeToolDefinitions[0]],
			isEnabled: () => true,
			isEnabledForSession: () => true,
			execute: (_state, context) => { receipts.push(context.invocation); return 'first reply'; },
		}]);
		await buildServerToolMcpServer(host, chatUri, sdk);
		manager.dispatchServerAction(chatUri, {
			type: ActionType.ChatTurnStarted, turnId: 'first-turn', startedAt: '2026-09-06T00:00:00Z',
			message: { text: 'Initial work', origin: { kind: MessageKind.User } },
		});
		const mapper = new ClaudeMapperState();
		const registry = disposables.add(new SubagentRegistry());
		for (const event of [
			makeContentBlockStartToolUse(0, 'native-first-call', 'mcp__host__serverToolA'),
			makeContentBlockStop(0),
		]) {
			for (const signal of mapSDKMessageToAgentSignals(makeStreamEvent('sdk-session', event), URI.parse(chatUri), 'first-turn', mapper, log, registry)) {
				if (signal.kind === 'action') {
					manager.dispatchServerAction(signal.resource.toString(), signal.action);
				}
			}
		}
		await recorded[0].handler({}, { _meta: { 'claudecode/toolUseId': 'native-first-call' } });

		assert.deepStrictEqual({
			initialTools: recorded.map(tool => tool.name),
			completedTurns: manager.getChatState(chatUri)?.turns.length,
			receipts,
		}, {
			initialTools: ['serverToolA'],
			completedTurns: 0,
			receipts: [{ toolCallId: 'native-first-call', turnId: 'first-turn' }],
		});
	});

	test('serverToolAllowList prefixes the given tool names for the SDK', () => {
		assert.deepStrictEqual(
			serverToolAllowList(['serverToolA', 'serverToolB']),
			[`mcp__${CLAUDE_SERVER_TOOL_MCP_SERVER_NAME}__serverToolA`, `mcp__${CLAUDE_SERVER_TOOL_MCP_SERVER_NAME}__serverToolB`],
		);
	});

	test('extractServerToolName returns only host MCP tool names', () => {
		assert.deepStrictEqual({
			hostTool: extractServerToolName(`mcp__${CLAUDE_SERVER_TOOL_MCP_SERVER_NAME}__serverToolA`),
			otherMcpTool: extractServerToolName('mcp__other__serverToolA'),
			bareTool: extractServerToolName('serverToolA'),
		}, {
			hostTool: 'serverToolA',
			otherMcpTool: undefined,
			bareTool: undefined,
		});
	});
});
