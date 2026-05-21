# Access-To-Power Helper Installer

The helper is a Windows desktop component. It reads `.accdb` and `.mdb` files
locally with ACE OLEDB, then uploads migration artifacts to Dataverse.

## Install

1. Extract the helper zip to a local folder.
2. Run PowerShell as the target user.
3. Run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install-helper.ps1
```

The installer copies the helper to `%LOCALAPPDATA%\AccessToPower\Helper`,
registers `accesstopower://`, and adds a per-user uninstall entry.

## Uninstall

Use Windows Settings > Apps, or run:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\AccessToPower\Helper\uninstall-helper.ps1"
```

## Prerequisite

Install the 64-bit Microsoft Access Database Engine on machines that need to
scan Access databases.