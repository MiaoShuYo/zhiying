; 知影 Zhiying — Inno Setup 6 安装脚本（V1.8.0）
;
; 由 scripts/build-installer.mjs 调用 ISCC.exe 编译，构建期注入：
;   /DAppVersion=1.8.0 /DAppVersion4=1.8.0.0 /DAppProfile=lite
;   /DPayloadDir=<dist\desktop\Zhiying-1.8.0-lite> /DOutDir=<dist>
;
; 安装业务：Inno 负责标准向导/文件复制/快捷方式/标准卸载器/Apps & Features 注册；
; 安装后由 [Code] CurStepChanged(ssPostInstall) 调用 payload 内
;   runtime\node\node.exe app\desktop\cli\setup-cli.mjs --post-install ...
; 收尾（写/校验 install.json、目录骨架、升级字段保留、日志）。
; 模型/用户数据目录不在 [Files] 中，升级与卸载默认保留；/PURGEDATA 供自动化显式清理。

#ifndef AppVersion
  #define AppVersion "1.8.0"
#endif

#ifndef AppVersion4
  #define AppVersion4 "1.8.0.0"
#endif

#ifndef AppProfile
  #define AppProfile "lite"
#endif

#ifndef PayloadDir
  #error 构建必须通过 /DPayloadDir=<发行目录> 指定 payload 目录
#endif

#ifndef OutDir
  #define OutDir "."
#endif

[Setup]
AppId={{7D3B2C1E-5A64-4E8B-9F27-3C1D8B6A4E50}
AppName=知影 Zhiying
AppVersion={#AppVersion}
AppVerName=知影 Zhiying {#AppVersion}
AppPublisher=MiaoShuYo
AppPublisherURL=https://github.com/MiaoShuYo/zhiying
AppSupportURL=https://github.com/MiaoShuYo/zhiying/issues
AppUpdatesURL=https://github.com/MiaoShuYo/zhiying
AppCopyright=Copyright (C) 2026 MiaoShuYo
DefaultDirName={localappdata}\Programs\Zhiying
DefaultGroupName=知影 Zhiying
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UsePreviousAppDir=yes
CloseApplications=yes
AllowNoIcons=yes
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputDir={#OutDir}
OutputBaseFilename=Zhiying-Setup
UninstallDisplayName=知影 Zhiying
UninstallDisplayIcon={app}\Zhiying.exe
VersionInfoVersion={#AppVersion4}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany=MiaoShuYo
VersionInfoDescription=知影 Zhiying 安装程序
VersionInfoProductName=知影 Zhiying
VersionInfoCopyright=Copyright (C) 2026 MiaoShuYo
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "zh"; MessagesFile: "languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
; 程序文件整体安装到 {app}；用户数据/模型/日志/既有 install.json 不随包覆盖（升级保留）。
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "models\*,models\*\*,data\*,data\*\*,logs\*,logs\*\*,config\install.json"

[Dirs]
; 用户数据目录不随卸载删除（models/data/logs/config 默认保留）。
Name: "{app}\models"; Flags: uninsneveruninstall
Name: "{app}\models\.downloads"; Flags: uninsneveruninstall
Name: "{app}\data"; Flags: uninsneveruninstall
Name: "{app}\data\tmp"; Flags: uninsneveruninstall
Name: "{app}\logs"; Flags: uninsneveruninstall
Name: "{app}\config"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\知影 Zhiying"; Filename: "{app}\Zhiying.exe"; WorkingDir: "{app}"; Comment: "启动知影"
Name: "{autodesktop}\知影"; Filename: "{app}\Zhiying.exe"; WorkingDir: "{app}"; Comment: "启动知影"; Tasks: desktopicon

[Run]
; 完成页：仅当用户选择“立即下载 AI 模型”时显示（启动本地模型管理器，服务只监听 127.0.0.1）。
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\app\desktop\cli\model-manager-cli.mjs"" --install-root ""{app}"" --open"; Description: "立即下载 AI 模型（打开模型管理器）"; Flags: postinstall nowait skipifsilent; Check: ShouldOfferModelDownload
Filename: "{app}\Zhiying.exe"; Description: "启动知影"; Flags: postinstall nowait skipifsilent

[Code]
var
  ModelPage: TInputOptionWizardPage;
  ModelChoice: String;
  PurgeData: Boolean;
  { 安装后收尾失败时置位；GetCustomSetupExitCode 据此让安装程序返回非 0。 }
  PostInstallFailed: Boolean;

{ 读取自定义命令行参数（如 /MODELDOWNLOAD=now、/PURGEDATA）。 }
function GetCustomParam(const Name: String): String;
var
  I: Integer;
  Value: String;
begin
  Result := '';
  for I := 1 to ParamCount do
  begin
    Value := ParamStr(I);
    if CompareText(Copy(Value, 1, Length(Name) + 1), Name + '=') = 0 then
    begin
      Result := Copy(Value, Length(Name) + 2, Length(Value));
      Exit;
    end;
  end;
end;

function HasCustomFlag(const Name: String): Boolean;
var
  I: Integer;
  Value: String;
begin
  Result := False;
  for I := 1 to ParamCount do
  begin
    Value := ParamStr(I);
    if (CompareText(Value, Name) = 0) or (CompareText(Copy(Value, 1, Length(Name) + 1), Name + '=') = 0) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function IsDriveRoot(const Dir: String): Boolean;
begin
  Result := (Length(Dir) <= 3) and (Copy(Dir, 2, 1) = ':');
end;

function IsProtectedDirectory(const Dir: String): Boolean;
var
  Normalized, ProtectedPrefix: String;
  Prefixes: array[0..4] of String;
  I: Integer;
begin
  Result := False;
  Normalized := AddBackslash(Lowercase(RemoveBackslash(Dir)));
  Prefixes[0] := ExpandConstant('{commonpf}');
  Prefixes[1] := ExpandConstant('{commonpf32}');
  Prefixes[2] := ExpandConstant('{win}');
  Prefixes[3] := ExpandConstant('{sys}');
  Prefixes[4] := ExpandConstant('{commonappdata}');
  for I := 0 to 4 do
  begin
    ProtectedPrefix := AddBackslash(Lowercase(RemoveBackslash(Prefixes[I])));
    if (Length(Normalized) >= Length(ProtectedPrefix)) and (Copy(Normalized, 1, Length(ProtectedPrefix)) = ProtectedPrefix) then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function FindExistingAncestor(const Dir: String): String;
var
  Current: String;
begin
  Current := RemoveBackslashUnlessRoot(Dir);
  while (Current <> '') and (not DirExists(Current)) do
  begin
    Current := ExtractFileDir(Current);
    if (Current = '') or (Length(Current) <= 3) then Break;
  end;
  if (Current <> '') and DirExists(Current) then Result := Current
  else Result := ExtractFileDrive(Dir) + '\';
end;

function IsDirectoryWritable(const Dir: String): Boolean;
var
  Probe: String;
begin
  Result := False;
  if not DirExists(Dir) then Exit;
  Probe := AddBackslash(Dir) + '.zhiying-write-probe.tmp';
  if SaveStringToFile(Probe, 'probe', False) then
  begin
    DeleteFile(Probe);
    Result := True;
  end;
end;

function ValidateInstallDir(const Dir: String): String;
var
  Parent: String;
begin
  Result := '';
  if Dir = '' then
  begin
    Result := '请输入安装目录。';
    Exit;
  end;
  if (Length(Dir) < 3) or (Copy(Dir, 2, 1) <> ':') then
  begin
    Result := '安装目录必须是带盘符的绝对路径，例如 D:\Zhiying。';
    Exit;
  end;
  if not DirExists(Copy(Dir, 1, 3)) then
  begin
    Result := '安装目录所在磁盘不存在：' + Copy(Dir, 1, 3) + '。请检查磁盘后重新选择。';
    Exit;
  end;
  if IsDriveRoot(Dir) then
  begin
    Result := '安装目录不能是盘符根目录，请选择其下的子目录，例如 D:\Zhiying。';
    Exit;
  end;
  if IsProtectedDirectory(Dir) then
  begin
    Result := '不能安装到受保护的系统目录（Program Files / Windows / System32 / ProgramData）。' + #13#10 +
      '请使用当前用户可写目录，例如 ' + ExpandConstant('{localappdata}') + '\Programs\Zhiying 或 D 盘自建目录。';
    Exit;
  end;
  Parent := FindExistingAncestor(Dir);
  if not IsDirectoryWritable(Parent) then
  begin
    Result := '目录不可写：' + Parent + '。请选择当前用户有写权限的目录（不要使用 Program Files 等受保护目录）。';
    Exit;
  end;
end;

function ShouldOfferModelDownload(): Boolean;
begin
  Result := ModelChoice = 'now';
end;

procedure InitializeWizard();
begin
  ModelPage := CreateInputOptionPage(
    wpSelectDir,
    '模型下载',
    '安装完成后是否立即下载 AI 模型？',
    '模型约 5.3 GB，需要联网，可随时在“设置 → 模型”中下载/暂停/续传。' + #13#10 +
    '选择“稍后下载”也可以先完成安装并启动知影。',
    True,
    False
  );
  ModelPage.Add('稍后下载（推荐）');
  ModelPage.Add('立即下载 AI 模型（约 5.3 GB，需要联网）');
  if ModelChoice = 'now' then ModelPage.SelectedValueIndex := 1
  else ModelPage.SelectedValueIndex := 0;
end;

function InitializeSetup(): Boolean;
begin
  ModelChoice := Lowercase(GetCustomParam('/MODELDOWNLOAD'));
  if (ModelChoice <> 'now') and (ModelChoice <> 'later') then ModelChoice := 'later';
  PurgeData := HasCustomFlag('/PURGEDATA');
  Result := True;
end;

function InitializeUninstall(): Boolean;
begin
  PurgeData := HasCustomFlag('/PURGEDATA');
  Result := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (ModelPage <> nil) and (PageID = ModelPage.ID) and WizardSilent;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ErrorText: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    ErrorText := ValidateInstallDir(WizardDirValue);
    if ErrorText <> '' then
    begin
      SuppressibleMsgBox(ErrorText, mbError, MB_OK, IDOK);
      Result := False;
      Exit;
    end;
  end
  else if (ModelPage <> nil) and (CurPageID = ModelPage.ID) then
  begin
    if ModelPage.SelectedValueIndex = 1 then ModelChoice := 'now'
    else ModelChoice := 'later';
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  AppDir, BackupDir, Stamp: String;
begin
  Result := '';
  AppDir := ExpandConstant('{app}');
  Stamp := GetDateTimeString('yyyyMMdd-hhnnss', #0, #0);
  BackupDir := AppDir + '\data\backups\' + Stamp;
  { 升级前备份既有 install.json 与 SQLite（存在时），失败不阻塞安装但记录日志。 }
  if FileExists(AppDir + '\config\install.json') then
  begin
    ForceDirectories(BackupDir);
    if not FileCopy(AppDir + '\config\install.json', BackupDir + '\install.json', False) then
      Log('警告：升级前备份 config\install.json 失败');
  end;
  if FileExists(AppDir + '\data\m2v.db') then
  begin
    ForceDirectories(BackupDir);
    if not FileCopy(AppDir + '\data\m2v.db', BackupDir + '\m2v.db', False) then
      Log('警告：升级前备份 data\m2v.db 失败');
  end;
end;

{ 收尾失败：记录日志、提示（静默安装时不弹窗）、并让安装以非 0 退出。
  ssPostInstall 里抛异常不会改变 Setup 的退出码，所以改用 PostInstallFailed + GetCustomSetupExitCode。 }
procedure FailPostInstall(const Message: String);
begin
  PostInstallFailed := True;
  Log('安装后收尾失败：' + Message);
  SuppressibleMsgBox(Message, mbError, MB_OK, IDOK);
end;

function GetCustomSetupExitCode(): Integer;
begin
  if PostInstallFailed then Result := 10 else Result := 0;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  NodeExe, Cli, Params, LogPath: String;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then Exit;

  LogPath := ExpandConstant('{app}\logs\setup-' + GetDateTimeString('yyyyMMdd-hhnnss', #0, #0) + '.log');
  NodeExe := ExpandConstant('{app}\runtime\node\node.exe');
  Cli := ExpandConstant('{app}\app\desktop\cli\setup-cli.mjs');
  if (not FileExists(NodeExe)) or (not FileExists(Cli)) then
  begin
    FailPostInstall('安装后收尾失败：缺少运行时或安装脚本。' + #13#10 + NodeExe + #13#10 + Cli);
    Exit;
  end;

  Params := '--post-install --target "' + ExpandConstant('{app}') + '"' +
    ' --profile {#AppProfile} --download-models ' + ModelChoice +
    ' --log "' + LogPath + '" --json';
  Log('运行安装后收尾：' + NodeExe + ' "' + Cli + '" ' + Params);
  if not Exec(NodeExe, '"' + Cli + '" ' + Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    FailPostInstall('无法运行安装后收尾程序。请查看日志目录：' + ExpandConstant('{app}\logs'));
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    FailPostInstall('安装后收尾失败（退出码 ' + IntToStr(ResultCode) + '）。' + #13#10 +
      '请查看安装日志：' + LogPath);
    Exit;
  end;
  { 收尾返回 0 也要确认 install.json 真的写出，否则安装视为失败。 }
  if not FileExists(ExpandConstant('{app}\config\install.json')) then
  begin
    FailPostInstall('安装后收尾没有生成 config\install.json。' + #13#10 + '请查看安装日志：' + LogPath);
    Exit;
  end;
  Log('安装后收尾完成：' + LogPath);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  AppDir := ExpandConstant('{app}');
  if PurgeData then
  begin
    { 仅显式 /PURGEDATA 时清理受管模型与用户数据；其余程序文件由 Inno 标准卸载处理。 }
    DelTree(AppDir + '\models', True, True, True);
    DelTree(AppDir + '\data', True, True, True);
    Log('已按 /PURGEDATA 删除 models 与 data');
    Exit;
  end;
  if not UninstallSilent then
  begin
    if MsgBox('是否保留个人项目与模型数据？' + #13#10 +
      '选择“是”保留（推荐）。选择“否”将删除 models 与 data（需要再次确认）。',
      mbConfirmation, MB_YESNO) = IDNO then
    begin
      if MsgBox('确定删除所有 AI 模型与个人项目数据吗？此操作不可恢复。',
        mbError, MB_YESNO) = IDYES then
      begin
        DelTree(AppDir + '\models', True, True, True);
        DelTree(AppDir + '\data', True, True, True);
        Log('用户确认删除 models 与 data');
      end;
    end;
  end;
end;


