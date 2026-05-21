export const helperInstallerUrl = import.meta.env.VITE_HELPER_INSTALLER_URL?.trim() || "";

export const helperInstallerVersion = import.meta.env.VITE_HELPER_INSTALLER_VERSION?.trim() || "0.1.0";

export const helperInstallCommand = "powershell.exe -ExecutionPolicy Bypass -File .\\install-helper.ps1";