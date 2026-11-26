import { commandLineMatches, hasInstanceMarker, readServiceState } from './launcher.js';
import type { InstallLayout } from './install-layout.js';
import { inspectPort, readProcessCommandLines } from './process-probe.js';

/**
 * #128: a model pull is only allowed against the Ollama server that the Zhiying launcher started.
 * OLLAMA_MODELS on the client does not move an already-running server's store, so a user's own Ollama
 * listening on the configured port would receive the model instead of <InstallRoot>/models.
 *
 * Returns undefined when the listener on `port` is the managed Ollama of the recorded launcher
 * instance, otherwise a message explaining why the pull is refused.
 */
export async function verifyManagedOllama(layout: InstallLayout, port: number): Promise<string | undefined> {
  const listener = await inspectPort(port);
  if (!listener.open) return `受管 Ollama 服务未运行（端口 ${port}）。请先通过知影启动器启动服务后再下载模型。`;
  const state = await readServiceState(layout);
  const service = state?.services.find(item => item.id === 'ollama');
  if (!state || !service) return `端口 ${port} 上的 Ollama 不是知影启动器启动的服务，已拒绝下载，以免模型写入其他 Ollama 的模型目录。请关闭占用该端口的程序，或在安装配置中更换受管 Ollama 端口。`;
  const ownerPid = listener.owner?.pid;
  if (ownerPid === undefined) return `无法确认端口 ${port} 的占用进程，已拒绝下载。请通过知影启动器重新启动服务后重试。`;
  const commandLine = (await readProcessCommandLines([ownerPid])).get(ownerPid);
  const owned = ownerPid === service.pid && (hasInstanceMarker(commandLine, state.instanceId) || commandLineMatches(commandLine, service.commandLine));
  if (!owned) return `端口 ${port} 被其他程序（PID ${ownerPid}${listener.owner?.name ? `，${listener.owner.name}` : ''}）占用，不是知影受管的 Ollama，已拒绝下载。请关闭该程序或更换受管 Ollama 端口。`;
  return undefined;
}
