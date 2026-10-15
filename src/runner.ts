import { RpcClient, type JsonAgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const [provider, model] = (process.env.RF_MODEL ?? 'openrouter/anthropic/claude-opus-5.5').split(/\/(.*)/);

export type Run = {
  steer(text: string): Promise<unknown>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  settled: Promise<boolean>;
};

export async function startRun(o: { seriesDir: string; instanceDir: string; env: Record<string, string>; message: string; onEvent: (e: JsonAgentSessionEvent) => void }): Promise<Run> {
  const client = new RpcClient({
    cliPath, cwd: o.seriesDir, provider, model,
    env: { ...o.env, PATH: `${app}/bin:${app}/.venv/bin:${process.env.PATH}` },
    args: ['--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates',
      '--tools', 'read,bash,edit,write', '--append-system-prompt', join(app, 'prompt.md'),
      '--thinking', process.env.RF_THINKING ?? 'high',
      '--session-dir', join(o.instanceDir, 'session'), '--session-id', 'main',
      ...JSON.parse(process.env.RF_PI_ARGS ?? '[]')],
  });
  const settled = new Promise<boolean>(resolve => client.onEvent(e => e.type === 'agent_settled' && resolve(e.aborted)));
  client.onEvent(o.onEvent);
  await client.start();
  await client.prompt(o.message);
  return {
    steer: text => client.steer(text),
    interrupt: async () => { await client.clearQueue(); await client.abort(); },
    stop: () => client.stop(),
    settled,
  };
}
