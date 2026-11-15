/**
 * `@m2v/desktop` 公共 API 入口。
 *
 * 所有可被其它模块/测试直接使用的源文件必须在此 re-export（CLI/native/UI 模板除外）。
 */
export * from './install-layout.js';
export * from './model-paths.js';
export * from './service-env.js';
export * from './process-probe.js';
export * from './launcher.js';
export * from './model-manifest.js';
export * from './ollama-pull.js';
export * from './downloader.js';
export * from './download-server.js';
export * from './installer.js';
export * from './maintenance.js';
