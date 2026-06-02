const defaultHelperInstallerUrl =
	"https://github.com/kellycason/Access-To-Power/releases/latest/download/AccessToPowerHelper-0.1.2-win-x64.zip";

export const helperInstallerUrl = import.meta.env.VITE_HELPER_INSTALLER_URL?.trim() || defaultHelperInstallerUrl;

export const helperInstallerVersion = import.meta.env.VITE_HELPER_INSTALLER_VERSION?.trim() || "0.1.2";

export const helperInstallCommand = "powershell.exe -ExecutionPolicy Bypass -File .\\install-helper.ps1";