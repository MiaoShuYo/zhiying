import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  transpilePackages: ['@m2v/schema', '@m2v/styles', '@m2v/video'],
  webpack(config, { nextRuntime }) {
    if (nextRuntime === 'edge') {
      // next dev always creates an edge compiler and it still builds instrumentation.ts, even
      // though this app ships no edge code. That compiler has externalsPresets.node disabled, so
      // the node: builtins reached from instrumentation.ts fail with UnhandledSchemeError.
      // Treating node builtins as externals lets the (never executed) edge instrumentation build.
      config.externalsPresets = { ...config.externalsPresets, node: true };
    }
    return config;
  },
};
export default nextConfig;
