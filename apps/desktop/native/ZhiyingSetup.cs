// 知影安装程序（V1.8.0 控制台向导薄壳）。
//
// 职责：定位/解压随包 payload（嵌入 zip 资源或同目录 payload.zip），调用
// payload 内 runtime\node\node.exe app\desktop\cli\setup-cli.mjs，转发退出码并清理临时目录。
// 图形安装页留待后续版本；本轮为控制台向导。
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

namespace Zhiying
{
    internal static class Setup
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
                // 回退。
            }
            return AppDomain.CurrentDomain.BaseDirectory;
        }

        private static string DefaultPerUserTarget()
        {
            string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Path.Combine("AppData", "Local"));
            }
            return Path.Combine(localAppData, Path.Combine("Programs", "Zhiying"));
        }

        private static string ProductVersion()
        {
            try
            {
                Version version = Assembly.GetExecutingAssembly().GetName().Version;
                if (version != null) return version.Major + "." + version.Minor + "." + version.Build;
            }
            catch (Exception)
            {
                // 回退。
            }
            return "1.8.0";
        }

        private static bool TryExtractPayload(string payloadZip, string destination, out string error)
        {
            error = null;
            try
            {
                if (!File.Exists(payloadZip))
                {
                    error = "找不到安装包内容：" + payloadZip;
                    return false;
                }
                Directory.CreateDirectory(destination);
                ZipFile.ExtractToDirectory(payloadZip, destination);
                return true;
            }
            catch (Exception exception)
            {
                error = "解压安装包失败：" + exception.Message;
                return false;
            }
        }

        private static bool TryExtractEmbedded(Stream resource, string destination, string scratchDirectory, out string error)
        {
            error = null;
            string tempZip = Path.Combine(scratchDirectory, "payload.zip.tmp");
            try
            {
                if (resource == null)
                {
                    error = "嵌入安装包资源缺失。";
                    return false;
                }
                using (FileStream stream = new FileStream(tempZip, FileMode.Create, FileAccess.Write))
                {
                    byte[] buffer = new byte[81920];
                    int read;
                    while ((read = resource.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        stream.Write(buffer, 0, read);
                    }
                }
                resource.Dispose();
                return TryExtractPayload(tempZip, destination, out error);
            }
            catch (Exception exception)
            {
                error = "解压嵌入安装包失败：" + exception.Message;
                return false;
            }
            finally
            {
                try { if (File.Exists(tempZip)) File.Delete(tempZip); } catch (Exception) { }
            }
        }

        private static string CreateExtractionDirectory(string baseDirectory)
        {
            string[] candidates = new string[]
            {
                Path.Combine(baseDirectory, ".zhiying-setup-" + Guid.NewGuid().ToString("N")),
                Path.Combine(Path.GetTempPath(), "zhiying-setup-" + Guid.NewGuid().ToString("N")),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Path.Combine("Zhiying", Path.Combine("Temp", "setup-" + Guid.NewGuid().ToString("N"))))
            };
            System.Collections.Generic.List<string> failures = new System.Collections.Generic.List<string>();
            for (int index = 0; index < candidates.Length; index++)
            {
                try
                {
                    Directory.CreateDirectory(Path.Combine(candidates[index], "payload"));
                    return candidates[index];
                }
                catch (Exception error)
                {
                    failures.Add(candidates[index] + "（" + error.GetType().Name + "：" + error.Message + "）");
                }
            }
            throw new Exception("无法创建安装临时目录（已尝试安装程序所在目录、TEMP、LOCALAPPDATA）：" + string.Join("；", failures.ToArray()));
        }

        private static string Ask(string prompt, string defaultValue)
        {
            Console.Write(prompt);
            string answer = Console.ReadLine();
            if (answer == null) return defaultValue;
            answer = answer.Trim();
            return answer.Length == 0 ? defaultValue : answer;
        }

        private static bool AskYesNo(string prompt, bool defaultValue)
        {
            string answer = Ask(prompt, defaultValue ? "Y" : "N");
            return answer.StartsWith("y", StringComparison.OrdinalIgnoreCase) || answer.StartsWith("是", StringComparison.OrdinalIgnoreCase);
        }

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                return Run(args);
            }
            catch (Exception error)
            {
                try
                {
                    Console.Error.WriteLine("安装程序发生未处理异常：" + error.GetType().FullName + "：" + error.Message);
                    Console.Error.WriteLine(error.StackTrace);
                }
                catch (Exception)
                {
                    // 控制台不可用时忽略。
                }
                return 4;
            }
        }

        private static int Run(string[] args)
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }
            try { Console.InputEncoding = new UTF8Encoding(false); } catch (Exception) { }
            try { Console.Title = "知影安装程序 Zhiying Setup " + ProductVersion(); } catch (Exception) { }

            bool silent = false;
            bool noLaunch = false;
            string target = null;
            string downloadModels = null;
            bool noShortcut = false;
            bool noRegistry = false;
            System.Collections.Generic.List<string> forwarded = new System.Collections.Generic.List<string>();
            for (int index = 0; index < args.Length; index++)
            {
                string argument = args[index];
                if (argument == "--silent") { silent = true; continue; }
                if (argument == "--no-launch") { noLaunch = true; continue; }
                if (argument == "--no-shortcut") { noShortcut = true; continue; }
                if (argument == "--no-registry") { noRegistry = true; continue; }
                // 控制台向导由本程序负责，不再把 --interactive 透传给 setup-cli（避免重复提问）。
                if (argument == "--interactive") { continue; }
                if (argument == "--target") { if (index + 1 < args.Length) { target = args[++index]; } continue; }
                if (argument.StartsWith("--target=", StringComparison.OrdinalIgnoreCase)) { target = argument.Substring("--target=".Length); continue; }
                if (argument == "--download-models") { if (index + 1 < args.Length) { downloadModels = args[++index]; } continue; }
                if (argument.StartsWith("--download-models=", StringComparison.OrdinalIgnoreCase)) { downloadModels = argument.Substring("--download-models=".Length); continue; }
                forwarded.Add(argument);
            }

            if (!silent)
            {
                Console.WriteLine("==============================================");
                Console.WriteLine("             知影 Zhiying 安装程序");
                Console.WriteLine("==============================================");
                Console.WriteLine("产品名称：知影 Zhiying（本地 AI 视频工作室）");
                Console.WriteLine("版本：" + ProductVersion());
                Console.WriteLine("发行者：知影 / Zhiying");
                Console.WriteLine("说明：安装知影桌面运行环境与启动器。本程序不要求管理员权限；");
                Console.WriteLine("      模型不会默认下载，安装完成后可选择立即或稍后下载。");
                Console.WriteLine("      所有知影管理的模型都会保存在安装目录的 models 文件夹内。");
                Console.WriteLine();
                if (target == null || target.Trim().Length == 0)
                {
                    target = Ask("请输入安装目录（直接回车使用默认 " + DefaultPerUserTarget() + "）：", DefaultPerUserTarget());
                }
                bool createShortcut = AskYesNo("是否创建桌面快捷方式？(Y/n)：", true);
                if (!createShortcut) noShortcut = true;
                string choice = Ask("安装完成后是否立即下载 AI 模型？now=立即下载，later=稍后下载（默认 later）：", "later");
                downloadModels = choice.StartsWith("n", StringComparison.OrdinalIgnoreCase) ? "now" : "later";
                if (!AskYesNo("确认安装到 " + target + " ？(Y/n)：", true))
                {
                    Console.WriteLine("已取消安装，未写入任何文件。");
                    return 2;
                }
            }

            string baseDirectory = ResolveBaseDirectory();
            string tempRoot = CreateExtractionDirectory(baseDirectory);
            string payloadDirectory = Path.Combine(tempRoot, "payload");
            string error;
            try
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                Stream embedded = null;
                try
                {
                    embedded = assembly.GetManifestResourceStream("payload.zip");
                }
                catch (Exception)
                {
                    embedded = null;
                }
                if (embedded != null)
                {
                    if (!TryExtractEmbedded(embedded, payloadDirectory, tempRoot, out error))
                    {
                        Console.Error.WriteLine(error);
                        return 3;
                    }
                }
                else
                {
                    string payloadZip = Path.Combine(baseDirectory, "payload.zip");
                    if (!TryExtractPayload(payloadZip, payloadDirectory, out error))
                    {
                        Console.Error.WriteLine(error);
                        return 3;
                    }
                }

                string nodeExe = Path.Combine(payloadDirectory, Path.Combine("runtime", Path.Combine("node", "node.exe")));
                string setupCli = Path.Combine(payloadDirectory, Path.Combine("app", Path.Combine("desktop", Path.Combine("cli", "setup-cli.mjs")))) ;
                if (!File.Exists(nodeExe) || !File.Exists(setupCli))
                {
                    Console.Error.WriteLine("安装包缺少运行时或安装脚本（runtime\\node\\node.exe / app\\desktop\\cli\\setup-cli.mjs）。");
                    return 3;
                }

                StringBuilder arguments = new StringBuilder();
                arguments.Append(Quote(setupCli));
                arguments.Append(" --payload ");
                arguments.Append(Quote(payloadDirectory));
                if (target != null && target.Trim().Length > 0)
                {
                    arguments.Append(" --target ");
                    arguments.Append(Quote(target.Trim()));
                }
                if (silent) arguments.Append(" --silent");
                if (noShortcut) arguments.Append(" --no-shortcut");
                if (noRegistry) arguments.Append(" --no-registry");
                if (noLaunch) arguments.Append(" --no-launch");
                if (downloadModels == "now" || downloadModels == "later")
                {
                    arguments.Append(" --download-models ");
                    arguments.Append(downloadModels);
                }
                for (int index = 0; index < forwarded.Count; index++)
                {
                    arguments.Append(' ');
                    arguments.Append(Quote(forwarded[index]));
                }

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = nodeExe;
                startInfo.Arguments = arguments.ToString();
                startInfo.WorkingDirectory = payloadDirectory;
                startInfo.UseShellExecute = false;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
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
                            Console.Error.WriteLine("无法启动安装脚本。");
                            return 3;
                        }
                        process.BeginOutputReadLine();
                        process.BeginErrorReadLine();
                        process.WaitForExit();
                        process.WaitForExit();
                        return process.ExitCode;
                    }
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine("运行安装脚本失败：" + exception.Message);
                    return 4;
                }
            }
            finally
            {
                try { if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, true); } catch (Exception) { }
            }
        }
    }
}
