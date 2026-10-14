"""Discover the same local converters used by PPT import."""
import os
import shutil
from pathlib import Path

MISSING_RENDERER = '保留原页画面需要安装 PowerPoint 或 LibreOffice；选择“提取内容重建”即可继续。'


def converters() -> dict[str, str | None]:
    roots = [os.environ.get('ProgramFiles', r'C:\Program Files'), os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')]
    libre = [shutil.which('soffice'), *[str(Path(root) / 'LibreOffice/program/soffice.exe') for root in roots]]
    powerpoint = [shutil.which('POWERPNT.EXE'), *[str(Path(root) / 'Microsoft Office/root/Office16/POWERPNT.EXE') for root in roots]]
    if os.name == 'nt':
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE') as key:
                    powerpoint.append(winreg.QueryValue(key, None).strip('"'))
            except OSError:
                pass
    exists = lambda paths: next((path for path in paths if path and Path(path).is_file()), None)
    return {'libreoffice': exists(libre), 'powerpoint': exists(powerpoint) if os.name == 'nt' else None}


def presentation_capabilities() -> dict:
    found = converters()
    available = any(found.values())
    return {'preservePptx': available, 'message': '' if available else MISSING_RENDERER}
