// 知影桌面启动器（V1.8.0 薄壳）。
//
// 职责：定位自身目录为 InstallRoot，用随包 runtime\node\node.exe 运行
// app\desktop\cli\launcher-cli.mjs，转发参数、stdout/stderr 与退出码。
// 不实现业务逻辑；所有进程/健康/端口逻辑在 TypeScript 层。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

namespace Zhiying
{
    internal static class Launcher
    {
        private static string Quote(string value)
        {
            if (value == null || value.Length == 0) return "\"\"";
            if (value.IndexOf(' ') < 0 && value.IndexOf('\t') < 0 && value.IndexOf('"') < 0) return value;
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static string ResolveBaseDirectory()
        {
            try
            {
                string location = Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(location)) return Path.GetDirectoryName(location);
            }
            catch (Exception)
            {
                // 回退到 AppDomain。
            }
            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private static int Fail(string message, bool interactive)
        {
            Console.Error.WriteLine("知影启动失败：" + message);
            if (interactive && !Console.IsInputRedirected)
            {
                Console.Error.WriteLine("按任意键关闭窗口…");
                try { Console.ReadKey(true); } catch (Exception) { }
            }
            return 2;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = new UTF8Encoding(false);
            }
            catch (Exception)
            {
                // 控制台编码不可设置时继续。
            }
            try { Console.Title = "知影 Zhiying"; } catch (Exception) { }

            string baseDirectory = ResolveBaseDirectory();
            if (string.IsNullOrEmpty(baseDirectory)) return Fail("无法定位安装目录。", args.Length == 0);
            baseDirectory = baseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

            string nodeExe = Path.Combine(baseDirectory, Path.Combine("runtime", Path.Combine("node", "node.exe")));
            string cli = Path.Combine(baseDirectory, Path.Combine("app", Path.Combine("desktop", Path.Combine("cli", "launcher-cli.mjs")))) ;
            if (!File.Exists(nodeExe))
            {
                return Fail("缺少运行时：" + nodeExe + "。请重新运行 Zhiying-Setup.exe 修复安装。", args.Length == 0);
            }
            if (!File.Exists(cli))
            {
                return Fail("缺少启动器脚本：" + cli + "。请重新运行 Zhiying-Setup.exe 修复安装。", args.Length == 0);
            }

            StringBuilder arguments = new StringBuilder();
            arguments.Append(Quote(cli));
            arguments.Append(" --install-root ");
            arguments.Append(Quote(baseDirectory));
            for (int index = 0; index < args.Length; index++)
            {
                arguments.Append(' ');
                arguments.Append(Quote(args[index]));
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = nodeExe;
            startInfo.Arguments = arguments.ToString();
            startInfo.WorkingDirectory = baseDirectory;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = false;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.RedirectStandardInput = false;
            try
            {
                using (Process process = new Process())
                {
                    process.StartInfo = startInfo;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (eventArgs.Data != null) Console.Out.WriteLine(eventArgs.Data);
                    };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                    {
                        if (eventArgs.Data != null) Console.Error.WriteLine(eventArgs.Data);
                    };
                    if (!process.Start())
                    {
                        return Fail("无法启动 Node 运行时。", args.Length == 0);
                    }
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                return Fail(error.Message, args.Length == 0);
            }
        }
    }
}
