// 知影安装器启动壳。
//
// Inno Setup 的 SetupLdr 会在执行安装脚本前先在 Windows 临时目录创建 is-*.tmp。
// 若用户的 TEMP/TMP ACL 异常，Inno 的 [Code] 还没有机会运行。本启动壳把内嵌的
// Inno 安装器解到当前用户 LocalAppData 下的独立目录，并只为安装器子进程设置
// TEMP/TMP，从而绕过损坏的系统临时目录 ACL；不修改用户/系统环境变量。
//
// #124：解出的安装器在 Process.Start 前若被其他账户替换，就会以安装用户的身份执行。
// 因此 run-* 目录创建时即使用不继承的私有 ACL（仅当前用户、SYSTEM、Administrators），
// 并拒绝其他账户可删除/改名子项或修改权限的回退根目录（例如共享的 TEMP）。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
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

        // 原样转发原始命令行参数：Main 的 args 已被去引号，若再次转义会把
        // /TASKS="desktopicon" 这类带引号参数变成字面量引号，导致内嵌 Inno 安装器丢失任务。
        private static string RawArguments(string[] fallbackArgs)
        {
            string commandLine = Environment.CommandLine ?? String.Empty;
            int index = 0;
            while (index < commandLine.Length && Char.IsWhiteSpace(commandLine[index])) index++;
            if (index < commandLine.Length && commandLine[index] == '"')
            {
                index++;
                while (index < commandLine.Length && commandLine[index] != '"') index++;
                if (index < commandLine.Length) index++;
            }
            else
            {
                while (index < commandLine.Length && !Char.IsWhiteSpace(commandLine[index])) index++;
            }
            string raw = commandLine.Substring(index).TrimStart();
            return raw.Length > 0 || fallbackArgs.Length == 0 ? raw : BuildArguments(fallbackArgs);
        }

        private static void AddStagingRoot(List<string> roots, string path)
        {
            if (String.IsNullOrWhiteSpace(path)) return;
            try
            {
                string fullPath = Path.GetFullPath(path);
                for (int index = 0; index < roots.Count; index++)
                {
                    if (String.Equals(roots[index], fullPath, StringComparison.OrdinalIgnoreCase)) return;
                }
                roots.Add(fullPath);
            }
            catch { /* Ignore malformed or unavailable fallback paths. */ }
        }

        // NT SERVICE\TrustedInstaller owns many system folders and is as trusted as SYSTEM.
        private const string TrustedInstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

        private static SecurityIdentifier[] TrustedSids()
        {
            return new SecurityIdentifier[]
            {
                WindowsIdentity.GetCurrent().User,
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            };
        }

        private static bool IsTrustedSid(IdentityReference identity)
        {
            SecurityIdentifier sid = identity as SecurityIdentifier;
            if (sid == null) return false;
            foreach (SecurityIdentifier trusted in TrustedSids())
            {
                if (sid.Equals(trusted)) return true;
            }
            return sid.Value == TrustedInstallerSid;
        }

        // Rights on a staging root that let another account delete, rename or replace our
        // run-* directory, or rewrite the root's ACL to gain that ability.
        private static bool GrantsReplace(FileSystemAccessRule rule)
        {
            const int GenericAll = 0x10000000;
            FileSystemRights dangerous = FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
            return (rule.FileSystemRights & dangerous) != 0 || ((int)rule.FileSystemRights & GenericAll) != 0;
        }

        // Returns a description of the untrusted account that could tamper with entries of the
        // root, or null when only the current user, SYSTEM and Administrators can.
        private static string UntrustedControllerOf(string directory)
        {
            DirectorySecurity security = Directory.GetAccessControl(directory, AccessControlSections.Access | AccessControlSections.Owner);
            IdentityReference owner = security.GetOwner(typeof(SecurityIdentifier));
            if (owner == null || !IsTrustedSid(owner)) return "所有者 " + (owner == null ? "未知" : owner.Value);
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                // Inherit-only entries (e.g. CREATOR OWNER) do not apply to the root itself.
                if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                if (GrantsReplace(rule) && !IsTrustedSid(rule.IdentityReference)) return rule.IdentityReference.Value;
            }
            return null;
        }

        private static DirectorySecurity PrivateDirectorySecurity()
        {
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(WindowsIdentity.GetCurrent().User);
            InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            foreach (SecurityIdentifier sid in TrustedSids())
            {
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
            }
            return security;
        }

        private static void VerifyPrivateDirectory(string directory)
        {
            DirectorySecurity security = Directory.GetAccessControl(directory, AccessControlSections.Access | AccessControlSections.Owner);
            IdentityReference owner = security.GetOwner(typeof(SecurityIdentifier));
            if (!security.AreAccessRulesProtected || owner == null || !IsTrustedSid(owner))
                throw new UnauthorizedAccessException("无法为安装器临时目录设置私有权限");
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType == AccessControlType.Allow && !IsTrustedSid(rule.IdentityReference))
                    throw new UnauthorizedAccessException("安装器临时目录仍允许其他账户访问：" + rule.IdentityReference.Value);
            }
        }

        private static List<string> DefaultStagingRoots()
        {
            List<string> stagingRoots = new List<string>();
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!String.IsNullOrWhiteSpace(localAppData))
                AddStagingRoot(stagingRoots, Path.Combine(localAppData, "Zhiying", "InstallerStaging"));

            // LocalAppData is preferred because the ordinary Windows temp folder can have a
            // broken ACL. Some managed/restricted accounts have the opposite ACL layout, so
            // probe TEMP/TMP and the profile temp folder before giving up.
            AddStagingRoot(stagingRoots, Environment.GetEnvironmentVariable("TMP"));
            AddStagingRoot(stagingRoots, Environment.GetEnvironmentVariable("TEMP"));
            try { AddStagingRoot(stagingRoots, Path.GetTempPath()); } catch { }
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!String.IsNullOrWhiteSpace(userProfile))
                AddStagingRoot(stagingRoots, Path.Combine(userProfile, "Temp"));
            return stagingRoots;
        }

        // Returns the first private, writable run-* directory, or null when every root failed
        // (each failure is recorded in `failures`).
        private static string TryCreatePrivateStagingDirectory(List<string> stagingRoots, List<string> failures)
        {
            for (int rootIndex = 0; rootIndex < stagingRoots.Count; rootIndex++)
            {
                string stagingRoot = stagingRoots[rootIndex];
                string stagingDirectory = Path.Combine(stagingRoot, "run-" + Guid.NewGuid().ToString("N"));
                try
                {
                    Directory.CreateDirectory(stagingRoot);
                    string untrusted = UntrustedControllerOf(stagingRoot);
                    if (untrusted != null)
                        throw new UnauthorizedAccessException("其他账户可替换该目录中的内容（" + untrusted + "）");
                    // CreateDirectory ignores the ACL when the path already exists, so never reuse one.
                    if (Directory.Exists(stagingDirectory)) throw new IOException("临时目录已存在：" + stagingDirectory);
                    Directory.CreateDirectory(stagingDirectory, PrivateDirectorySecurity());
                    VerifyPrivateDirectory(stagingDirectory);
                    // Check real file creation before extraction or launching Inno Setup.
                    string probe = Path.Combine(stagingDirectory, ".write-probe-" + Guid.NewGuid().ToString("N"));
                    using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
                    File.Delete(probe);
                    return stagingDirectory;
                }
                catch (Exception error)
                {
                    failures.Add(stagingRoot + ": " + error.Message);
                    try { Directory.Delete(stagingDirectory, true); } catch { }
                }
            }
            return null;
        }

        private static string CreatePrivateStagingDirectory()
        {
            List<string> failures = new List<string>();
            string stagingDirectory = TryCreatePrivateStagingDirectory(DefaultStagingRoots(), failures);
            if (stagingDirectory != null) return stagingDirectory;
            throw new UnauthorizedAccessException(
                "无法创建可写的安装器临时目录。已尝试 LocalAppData、TEMP、TMP 和用户配置目录：" +
                Environment.NewLine + String.Join(Environment.NewLine, failures.ToArray()));
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

        // TEMP/TMP are set only for the Inno child process; the bootstrapper's own environment and the
        // user/system environment are never modified.
        private static ProcessStartInfo ChildStartInfo(string payloadPath, string[] args, string stagingDirectory)
        {
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = payloadPath;
            startInfo.Arguments = RawArguments(args);
            startInfo.WorkingDirectory = Environment.CurrentDirectory;
            startInfo.UseShellExecute = false;
            startInfo.EnvironmentVariables["TEMP"] = stagingDirectory;
            startInfo.EnvironmentVariables["TMP"] = stagingDirectory;
            return startInfo;
        }

        private static string JsonString(string value)
        {
            if (value == null) return "null";
            StringBuilder builder = new StringBuilder("\"");
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < ' ') builder.Append("\\u").Append(((int)c).ToString("x4"));
                        else builder.Append(c);
                        break;
                }
            }
            return builder.Append('"').ToString();
        }

        // #133 test-only probe. Enabled only when BOTH ZHIYING_BOOTSTRAP_PROBE=1 and
        // ZHIYING_BOOTSTRAP_STAGING_ROOTS (semicolon-separated candidate roots) are set: the
        // bootstrapper runs the staging selection against those roots, reports the result as JSON
        // (stdout, plus ZHIYING_BOOTSTRAP_PROBE_OUT when given), removes the directory it created and
        // exits (0 = selected, 5 = every root failed). The embedded installer is never extracted or
        // started, and no message box is shown. Ordinary launches never set these variables.
        private static int RunStagingProbe(string rootsSpec)
        {
            List<string> roots = new List<string>();
            foreach (string part in rootsSpec.Split(';')) AddStagingRoot(roots, part.Trim());
            List<string> failures = new List<string>();
            string parentTempBefore = Environment.GetEnvironmentVariable("TEMP");
            string parentTmpBefore = Environment.GetEnvironmentVariable("TMP");
            string selected = null;
            string childTemp = null;
            string childTmp = null;
            bool cleaned = true;
            try
            {
                selected = TryCreatePrivateStagingDirectory(roots, failures);
                if (selected != null)
                {
                    ProcessStartInfo startInfo = ChildStartInfo(Path.Combine(selected, "Zhiying-Setup-Payload.exe"), new string[0], selected);
                    childTemp = startInfo.EnvironmentVariables["TEMP"];
                    childTmp = startInfo.EnvironmentVariables["TMP"];
                    try { Directory.Delete(selected, true); } catch { }
                    cleaned = !Directory.Exists(selected);
                }
            }
            catch (Exception error)
            {
                failures.Add("probe: " + error.Message);
            }
            bool parentUnchanged = String.Equals(parentTempBefore, Environment.GetEnvironmentVariable("TEMP"), StringComparison.Ordinal)
                && String.Equals(parentTmpBefore, Environment.GetEnvironmentVariable("TMP"), StringComparison.Ordinal);

            StringBuilder json = new StringBuilder("{");
            json.Append("\"ok\":").Append(selected != null ? "true" : "false");
            json.Append(",\"selected\":").Append(JsonString(selected));
            json.Append(",\"selectedRoot\":").Append(JsonString(selected == null ? null : Path.GetDirectoryName(selected)));
            json.Append(",\"childTemp\":").Append(JsonString(childTemp));
            json.Append(",\"childTmp\":").Append(JsonString(childTmp));
            json.Append(",\"parentTemp\":").Append(JsonString(Environment.GetEnvironmentVariable("TEMP")));
            json.Append(",\"parentEnvUnchanged\":").Append(parentUnchanged ? "true" : "false");
            json.Append(",\"cleaned\":").Append(cleaned ? "true" : "false");
            json.Append(",\"roots\":[");
            for (int index = 0; index < roots.Count; index++) { if (index > 0) json.Append(','); json.Append(JsonString(roots[index])); }
            json.Append("],\"failures\":[");
            for (int index = 0; index < failures.Count; index++) { if (index > 0) json.Append(','); json.Append(JsonString(failures[index])); }
            json.Append("]}");
            string output = json.ToString();

            string outPath = Environment.GetEnvironmentVariable("ZHIYING_BOOTSTRAP_PROBE_OUT");
            if (!String.IsNullOrWhiteSpace(outPath))
            {
                try { File.WriteAllText(outPath, output, new UTF8Encoding(false)); } catch { }
            }
            try { Console.Out.WriteLine(output); Console.Out.Flush(); } catch { }
            return selected != null ? 0 : 5;
        }

        private static int RunSetup(string[] args)
        {
            string stagingDirectory = null;
            try
            {
                stagingDirectory = CreatePrivateStagingDirectory();
                string payloadPath = Path.Combine(stagingDirectory, "Zhiying-Setup-Payload.exe");
                ExtractPayload(payloadPath);

                ProcessStartInfo startInfo = ChildStartInfo(payloadPath, args, stagingDirectory);

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
            string probeRoots = Environment.GetEnvironmentVariable("ZHIYING_BOOTSTRAP_STAGING_ROOTS");
            if (Environment.GetEnvironmentVariable("ZHIYING_BOOTSTRAP_PROBE") == "1" && !String.IsNullOrWhiteSpace(probeRoots))
                return RunStagingProbe(probeRoots);
            return RunSetup(args);
        }
    }
}
