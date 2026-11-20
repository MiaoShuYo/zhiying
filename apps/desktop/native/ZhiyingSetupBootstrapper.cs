// 知影安装器启动壳。
//
// Inno Setup 的 SetupLdr 会在执行安装脚本前先在 Windows 临时目录创建 is-*.tmp。
// 若用户的 TEMP/TMP ACL 异常，Inno 的 [Code] 还没有机会运行。本启动壳把内嵌的
// Inno 安装器解到当前用户 LocalAppData 下的独立目录，并只为安装器子进程设置
// TEMP/TMP，从而绕过损坏的系统临时目录 ACL；不修改用户/系统环境变量。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

namespace Zhiying
{
    internal static class SetupBootstrapper
    {
        private const string PayloadResourceName = "Zhiying.SetupPayload";

        private static string QuoteArgument(string value)
        {
            if (value == null) value = String.Empty;
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;

            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            for (int index = 0; index < value.Length; index++)
            {
                char current = value[index];
                if (current == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (current == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                backslashes = 0;
                quoted.Append(current);
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private static string BuildArguments(string[] args)
        {
            StringBuilder result = new StringBuilder();
            for (int index = 0; index < args.Length; index++)
            {
                if (index > 0) result.Append(' ');
                result.Append(QuoteArgument(args[index]));
            }
            return result.ToString();
        }

        private static string CreatePrivateStagingDirectory()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (String.IsNullOrWhiteSpace(localAppData))
                throw new InvalidOperationException("Windows 未提供当前用户的 LocalAppData 路径。");

            string stagingRoot = Path.Combine(localAppData, "Zhiying", "InstallerStaging");
            Directory.CreateDirectory(stagingRoot);
            string stagingDirectory = Path.Combine(stagingRoot, "run-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stagingDirectory);
            try
            {
                // 先做一次真实写入检查，确保失败能在解包之前给出可读提示。
                string probe = Path.Combine(stagingDirectory, ".write-probe-" + Guid.NewGuid().ToString("N"));
                using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
                File.Delete(probe);
                return stagingDirectory;
            }
            catch
            {
                try { Directory.Delete(stagingDirectory, true); } catch { }
                throw;
            }
        }

        private static void ExtractPayload(string targetPath)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream source = assembly.GetManifestResourceStream(PayloadResourceName))
            {
                if (source == null)
                    throw new InvalidOperationException("安装包缺少内嵌的 Inno Setup 数据。");
                using (FileStream target = new FileStream(targetPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    source.CopyTo(target);
            }
        }

        private static int RunSetup(string[] args)
        {
            string stagingDirectory = null;
            try
            {
                stagingDirectory = CreatePrivateStagingDirectory();
                string payloadPath = Path.Combine(stagingDirectory, "Zhiying-Setup-Payload.exe");
                ExtractPayload(payloadPath);

                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = payloadPath;
                startInfo.Arguments = BuildArguments(args);
                startInfo.WorkingDirectory = Environment.CurrentDirectory;
                startInfo.UseShellExecute = false;
                startInfo.EnvironmentVariables["TEMP"] = stagingDirectory;
                startInfo.EnvironmentVariables["TMP"] = stagingDirectory;

                using (Process process = Process.Start(startInfo))
                {
                    if (process == null) throw new InvalidOperationException("Windows 未能启动内嵌安装程序。");
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "无法启动知影安装程序。" + Environment.NewLine + Environment.NewLine + error.Message +
                    (stagingDirectory == null ? String.Empty : Environment.NewLine + Environment.NewLine + "临时目录：" + stagingDirectory),
                    "知影 Zhiying 安装程序",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                if (!String.IsNullOrEmpty(stagingDirectory))
                {
                    try { Directory.Delete(stagingDirectory, true); }
                    catch { /* 安装器/安全软件短暂占用文件时，留给系统后续清理。 */ }
                }
            }
        }

        [STAThread]
        private static int Main(string[] args)
        {
            return RunSetup(args);
        }
    }
}
