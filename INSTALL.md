# How to install Access to Power

Welcome! This guide walks you through getting **Access to Power** up and running.
You'll do this **once**, then you can migrate as many Access databases as you want.

There are **three things** to install:

1. 🟦 **The Dataverse solution** — creates the migration tables in Power Platform.
2. 🟦 **The Code App** — the browser app you use to run migrations.
3. 🟧 **The helper** — a tiny program that lives on **your own Windows PC**. It reads the
   Access file off your hard drive (because a web browser can't).

> ⏱️ **Total time:** about 15 minutes.
> 🔑 **What you need:** a Power Apps license, a Dataverse environment, and a Windows PC.

---

## Before you start — the checklist

Tick these off first. If anything's missing, grab it before going further.

- [ ] A **Power Apps Premium** license (the app uses Code Apps, which is a premium feature).
- [ ] A **Dataverse environment** you can create tables in. If you're not sure, ask your
      Power Platform admin: *"Can you give me a Dataverse environment where I'm a System
      Customizer or System Administrator?"*
- [ ] A **Windows PC** (Windows 10 or Windows 11). The helper does not run on Mac or Linux.
- [ ] The **64-bit Microsoft Access Database Engine**. This is a free download from
      Microsoft. Without it the helper can't read `.accdb` files.
      👉 Search the web for **"Microsoft Access Database Engine 2016 Redistributable"** and
      grab the **`AccessDatabaseEngine_X64.exe`** version.
- [ ] The **Access to Power solution file** (`AccessToPower_x_x_x_managed.zip`) — your
      admin or whoever sent you here should have given you this file.
- [ ] The **helper installer zip** (`AccessToPowerHelper-0.1.2-win-x64.zip`). Download the
      latest one from the project's GitHub Releases page:
      👉 **https://github.com/kellycason/Access-To-Power/releases/latest**
- [ ] **Node.js 20 or newer** and **Git** on the machine you will use to deploy the Code App.

> ❓ **What's a Dataverse environment?** Think of it like a database in the cloud where
> Power Apps stores its stuff. Your company probably already has one (or several). You
> need permission to add new tables to it.

---

# 🟦 Part 1 — Import the Dataverse solution

This creates the **Access to Power** Dataverse tables in your Power Platform environment.
The Code App itself is deployed in the next part.

## Step 1 — Open the Power Platform Admin Center

1. Open your web browser.
2. Go to 👉 **https://admin.powerplatform.microsoft.com**
3. Sign in with your work account.

## Step 2 — Pick your environment

1. On the left side, click **Environments**.
2. Click the **name** of the environment you want to install the app into.
   (If you only see one, that's the one.)

## Step 3 — Import the solution

1. Near the top of the page, click **Resources** ▸ **Solutions**.
   *(Or click the **Solutions** tile on the environment overview.)*
2. Click the **Import solution** button at the top.
3. Click **Browse** and pick the file:
   **`AccessToPower_x_x_x_managed.zip`** (the one you got from your admin).
4. Click **Next**.
5. Click **Next** again on any "connections" page — there are none to set up here.
6. Click **Import**.
7. Wait. ⏳ This usually takes **2–5 minutes**. Don't close the tab. When it's done you'll
   see a green check.

> ✅ **You'll know it worked when** you see "Access to Power" in your solutions list with
> a green "Managed" tag.

---

# 🟦 Part 2 — Deploy the Code App

Power Apps Code Apps are currently in preview and are not packaged inside the solution zip.
You deploy the Code App from this GitHub repo after the solution import succeeds.

## Step 1 — Clone the repo

Open PowerShell in the folder where you keep source code, then run:

```powershell
git clone https://github.com/kellycason/Access-To-Power.git
cd Access-To-Power
npm install
```

## Step 2 — Point the Code App at your environment

Open `power.config.json` and set:

- `region` to your Power Platform region, such as `unitedstates`, `gccmoderate`, or `europe`.
- `environmentId` to the Environment ID from Power Platform Admin Center.

If `appId` is already filled in from another environment, leave it alone for now; the first
`power:init` in your environment can register or update the app binding.

## Step 3 — Configure the helper download shown in the app

Run these in the same PowerShell window:

```powershell
$env:VITE_HELPER_INSTALLER_URL = "https://github.com/kellycason/Access-To-Power/releases/latest/download/AccessToPowerHelper-0.1.2-win-x64.zip"
$env:VITE_HELPER_INSTALLER_VERSION = "0.1.2"
```

## Step 4 — Push the Code App

Run:

```powershell
npm run power:init
npm run power:push
```

Sign in if the Power Apps CLI asks. When the push finishes, open the app from Power Apps
or from the URL printed by the CLI.

> 🎉 **The cloud app is installed!** Now install the helper on the workstation that has
> the Access database.

---

# 🟧 Part 3 — Install the helper (the PC part)

The helper is a small Windows program. It does **one** thing: when the app asks it to,
it opens your Access file and uploads what's inside.

> 🔐 **Is this safe?** Yes. The helper runs as **you**, only when **you** open the app,
> and only reads files **you** point it at. It doesn't run in the background. It doesn't
> phone home. It signs into the same Microsoft account you already use.

## Step 1 — Install the Access Database Engine (one time)

> ⏭️ **Skip this step** if you already have Microsoft Access installed on this PC, or
> if your IT department has already pushed the database engine to your machine.

1. Download **`AccessDatabaseEngine_X64.exe`** from Microsoft's website.
2. Double-click it.
3. Click **Next**, accept the license, click **Install**.
4. When it says "Setup Completed Successfully," click **OK**.

## Step 2 — Unzip the helper

1. Download **`AccessToPowerHelper-0.1.2-win-x64.zip`** from
   **https://github.com/kellycason/Access-To-Power/releases/latest**
   *(or use the copy your admin sent you).*
2. **Right-click** the zip file.
3. Choose **Extract All...** in the menu that pops up.
4. Click **Extract**. Windows makes a new folder next to the zip with the same name.
5. Open that new folder. You should see files like:
   - `AccessToPowerHelper.exe`
   - `install-helper.ps1`
   - `uninstall-helper.ps1`
   - `README.md`

## Step 3 — Run the installer

This is the only part that uses a tiny bit of PowerShell. **It's just two clicks and
one paste.** Follow exactly:

1. In the folder from step 2, **hold Shift** and **right-click** in some empty space
   inside the folder (not on a file).
2. Choose **Open in Terminal** (or **Open PowerShell window here** on older Windows).
   A black-or-blue window opens.
3. **Copy** the line below by clicking it once:

   ```powershell
   powershell.exe -ExecutionPolicy Bypass -File .\install-helper.ps1
   ```

4. **Paste** it into the black window. (Right-click in the window, or press **Ctrl+V**.)
5. Press **Enter**.

The installer prints a few lines like `==> Installing helper to ...` and finishes with:

```
Access-To-Power Helper installed successfully.
```

> ✅ **You'll know it worked when** you see the green
> "installed successfully" message. You can close the black window now.

> ⚠️ **If you see a yellow warning** that says "Microsoft ACE OLEDB provider was not
> detected" — go back to Step 1 and install the Access Database Engine. The helper
> installed, but it won't be able to read `.accdb` files until that engine is on your PC.

## Step 4 — That's it!

The helper is now installed in `C:\Users\<you>\AppData\Local\AccessToPower\Helper`.
You'll **never need to open it manually** — the app will pop it open for you when it
needs to read a file.

If you want to verify, look in **Settings ▸ Apps ▸ Installed apps** and search for
**"Access-To-Power Helper"**. It should be in the list.

---

# ✅ Try it out

1. Open the **Access to Power** Code App.
2. Click **New Migration**.
3. When the app asks you to pick your `.accdb` file, your browser may show a popup
   asking *"Open AccessToPowerHelper?"* — click **Open** (and tick "Always allow…" if
   you don't want to be asked again).
4. The helper opens, prompts you to sign in with your work account, and lets you pick your `.accdb`.

🎊 **You're done!** Follow the wizard from there.

---

# 🆘 Help! Something went wrong

| What you see | What to do |
| --- | --- |
| **"This page can't be displayed"** when you click an `accesstopower://` link | The helper isn't installed yet, or didn't register. Re-run **Part 3 ▸ Step 3**. |
| **"Solution import failed"** in Part 1 | Make sure you're a System Customizer or System Administrator on that environment. If you are, try once more — sometimes the platform is just busy. |
| **`power:init` or `power:push` fails** | Make sure `power.config.json` has the right `region` and `environmentId`, then sign in with an account that can create Code Apps in that environment. |
| **Yellow "ACE OLEDB provider was not detected"** warning | Install the Microsoft Access Database Engine — see **Part 3 ▸ Step 1**. |
| **"Cannot run scripts on this system"** when running the installer | You typed `install-helper.ps1` directly. Use the **full command** in **Part 3 ▸ Step 3** — it starts with `powershell.exe -ExecutionPolicy Bypass …`. |
| **The helper opens but says "Sign-in failed"** | Make sure you're signing in with the **same account** you use for Power Apps, and that account has access to the target environment. |
| **The app doesn't see the helper when I click "Scan"** | Close the browser tab and reopen the app. Make sure you ran the installer (not just unzipped the folder). |

---

# 🗑️ How to uninstall

**The helper:** Open **Settings ▸ Apps ▸ Installed apps**, find **Access-To-Power Helper**,
click the three dots, click **Uninstall**.

**The app:** In the Power Platform admin center, go to your environment ▸ **Solutions**,
find **Access to Power**, click the three dots, click **Delete**.

---

# 📚 Want to know more?

- Architecture and design: see [README.md](README.md).
- Installer details: see [helper/installer/README.md](helper/installer/README.md).
- Source code: this whole repo. Issues and pull requests welcome.
