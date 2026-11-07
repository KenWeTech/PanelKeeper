<p align="center">
  <img src="https://github.com/KenWeTech/PanelKeeper/blob/main/logo.png?raw=true" alt="PanelKeeper Logo" width="200"/>
</p>

# PanelKeeper

**PanelKeeper is a self-hosted Manga Library Manager.** It organizes CBZ collections, automates incoming chapter processing, and provides tools for metadata, covers, inventory, quality control, and recovery.

PanelKeeper organizes CBZ files from configured download folders into a managed manga library. It combines source-folder mapping, chapter and volume identification, conservative chapter replacement, library inventory, quality control, metadata maintenance, recovery, and optional integrations in one local web application.

PanelKeeper works with files that already exist in your configured folders. It does not search for or download manga, and it is not a general-purpose manga reader. Its page viewer is intended for comparing and editing CBZ archives during library maintenance.

## Features

- **Automated CBZ processing:** Map incoming source folders to destination manga folders. Scheduled processing handles new files and applies the configured naming, metadata, and cover rules.
- **Chapter-aware organization:** Recognizes chapter numbers, decimals, lettered parts, named Specials, and optional per-manga volume modes. Global ignored words and phrases apply across the library; additional per-series rules are stored separately and apply only to the selected manga. Both are combined during chapter parsing and QC.
- **Conservative chapter upgrades:** Compares image content and reading order before replacing an existing chapter. Verified upgrades move the previous version to Recovery. Uncertain comparisons are sent to Chapter Conflicts so both copies can be reviewed.
- **Quality Control:** Scans library archives for naming, Special-path, ComicInfo, archive, and duplicate-chapter issues. Results are cached, can be dismissed as not an issue, and can be repaired or routed to the appropriate review queue.
- **Library Manager:** Tracks manga folders and chapter inventory, identifies numeric gaps and duplicate chapter IDs, supports folder rename/merge, chapter renaming, and removal to Recovery.
- **Completed-series tracking:** Mark a manga complete to protect existing chapters from automatic replacement and save a fresh chapter baseline. Later successful inventory scans detect previously tracked files that have disappeared, including trailing chapters beyond the current highest number.
- **Chapter covers:** Select an image already in a manga folder or import one, then insert it as the first page of existing and future CBZ files. This standard workflow does not require Kavita. You can also download Kavita's main manga cover as a standalone folder image and choose it manually without enabling Auto Cover. Auto Cover is a separate optional integration that generates chapter-specific first pages; it does not replace the local-cover workflow.
- **ComicInfo metadata:** Choose a global handling policy for incoming CBZ files, scheduled library maintenance, and QC repairs. Leave, Update, Remove, Replace, and Upgrade each have a distinct effect. Global and per-series templates are available for Replace and Upgrade.
- **Recovery and review queues:** Preserve displaced files and provide dedicated Conflicts, Attention, and Recovery work areas.
- **Scheduling and integrations:** Run processing and optional QC on a schedule. Optional Kavita integration and Home Assistant webhook notifications are available.

## Requirements

- Node.js **20.9 or newer**
- npm
- Read/write access to the source and destination folders
- A writable location for the SQLite databases

PanelKeeper can run on Windows, macOS, or Linux. The Node.js process must run under an account that can access the configured folders. On Windows, mapped drives may not be visible to services or scheduled tasks running under a different account; a UNC path may be more reliable in that situation.

**Kavita Users:** Add the following exclude pattern to your Kavita library settings to prevent Kavita from scanning PanelKeeper's recovery folder:

```text
**/.panelkeeper-recovery/*
```

## Installation

1. Download and extract the latest ⁠`PanelKeeper-vX.X.X.zip`⁠ archive from [GitHub Releases](https://github.com/KenWeTech/PanelKeeper/releases).
2. Open a terminal in the project directory.
3. Install dependencies and start the server:

   ```sh
   npm install
   npm start
   ```

4. Open `http://localhost:7001` in a browser. Set `PORT` to use a different port.
5. Open **Settings**, configure the source and destination folders, and use **Test Paths** to confirm that both locations are accessible before processing files.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | Web server port. Defaults to `7001`. |
| `DB_PATH` | Main SQLite database path. Defaults to `panelkeeper.db` in the project directory. |
| `QC_DB_PATH` | Separate QC database path. By default, PanelKeeper creates a companion database named `panelkeeper_qc.db` beside the main database. |
| `MANGA_SOURCE_ROOT` | Initial source-folder value for a new database. Configure or verify it in Settings. |
| `MANGA_DESTINATION` | Initial destination-folder value for a new database. Configure or verify it in Settings. |

Saved database settings take precedence over the two initial folder environment variables. The source and destination settings are intentionally blank on a fresh installation so each installation can be configured for its own storage layout.

This first public release creates the current `panelkeeper.db` and `panelkeeper_qc.db` schemas directly. It does not import or upgrade databases from private development builds. When using an existing development library, set `DB_PATH` and `QC_DB_PATH` to the current PanelKeeper database files before starting the server.

## Docker Deployment

This is the simplest way to get PanelKeeper running using Docker Compose.

1. **Create a `docker-compose.yml` file:** Create a new file named `docker-compose.yml` and paste the following:

   ```yaml
   services:
     panelkeeper:
       image: ghcr.io/kenwetech/panelkeeper:latest
       container_name: panelkeeper
       restart: unless-stopped
       ports:
         - "7001:7001"
       environment:
         PORT: 7001
         DB_PATH: /app/data/panelkeeper.db
         QC_DB_PATH: /app/data/panelkeeper_qc.db
         LOG_PATH: /app/data/manager_history.log
         MANGA_SOURCE_ROOT: /downloads
         MANGA_DESTINATION: /manga
       volumes:
         # PanelKeeper databases and application history
         - ./data:/app/data
         # Incoming manga/download source folder
         - /path/to/your/downloads:/downloads
         # Managed manga library
         - /path/to/your/manga-library:/manga
   ```

   **Volume configuration:**
   - `./data:/app/data` stores the application databases and history log persistently.
   - `/path/to/downloads:/downloads` maps your host's manga download folder.
   - `/path/to/manga:/manga` maps your host's manga library folder.

   Replace `/path/to/downloads` and `/path/to/manga` with the actual paths on your host system. The container-side paths (`/downloads` and `/manga`) must match the corresponding values in your `.env` file if used.

   **Important:** The manga paths are used to initialize a new database. Once these settings have been saved in PanelKeeper, the database settings take precedence over changes to the `.env` file. Update existing paths through PanelKeeper Settings.

2. **Start the container:** Open a terminal in the directory containing your `docker-compose.yml` file and run:

   ```bash
   docker compose up -d
   ```

   Docker will download the image and start PanelKeeper. The `data` folder will be created alongside your Compose file to persist the databases and application history across container updates and recreations.

3. **Access PanelKeeper:** Open your browser and navigate to:

   `http://localhost:7001`

   To access PanelKeeper from another device on your network, use the IP address of the machine running Docker:

   `http://YOUR-SERVER-IP:7001`

**Note:** Ensure the downloads and manga library folders have read/write permissions for the container. PanelKeeper needs access to both locations to process and organize manga files.

## First-time configuration

1. **Configure paths.** In Settings, choose the folder that receives downloads and the destination manga library. Test both paths before running the pipeline.
2. **Review Series Mapper.** Match each incoming source folder to its destination manga. Multiple source folders can point to the same destination series.
3. **Set ignored filename text.** In Series Mapper, use **Global Chapter Filename Ignore Rules** for release tags or phrases shared by multiple manga. Select a destination manga to load and edit its separately stored per-series rules. When editing an existing mapping and changing its destination, PanelKeeper loads the new destination’s rules before saving. The two lists remain separate and are combined only when PanelKeeper processes that manga. A term shown in the global editor currently applies to every manga; remove it there before adding it as a per-series-only rule.
4. **Choose metadata and cover behavior.** Review the ComicInfo policy, optional chapter-cover designs, and any Kavita connection before enabling automatic processing.
5. **Choose a schedule.** Set the processing schedule and, separately, whether automatic QC is enabled and how often it runs.
6. **Configure notifications if needed.** Add a Home Assistant webhook URL and choose which events should send a notification.

Start with a small test set or a backup of the destination library before enabling unattended processing on an established collection.

## How processing handles existing chapters

When an incoming file matches a chapter already in the destination library, PanelKeeper compares the archive's image entries and their order rather than using archive size or page count as proof of completeness.

- If the incoming file contains all the existing page images in the same order and adds additional pages, PanelKeeper can install it as an upgrade and move the displaced library copy into Recovery.
- If the incoming file is an exact duplicate or an incomplete subset of the current library copy, the incoming copy can be discarded as a duplicate.
- If the contents differ, cannot be verified safely, or multiple library files match the same chapter identity, PanelKeeper preserves both files and creates a Chapter Conflict for review.

This is a conservative comparison, not an image-understanding system. Differently cropped, re-encoded, or rearranged pages may require manual comparison even when they depict the same content.

## Quality Control and library maintenance

Quality Control checks filenames, chapter parsing, Special-folder placement, ComicInfo metadata actions, archive integrity, and duplicate chapter identities. ComicInfo findings are evaluated against the saved policy: Leave alone makes no changes, Update corrects existing chapter identity fields, Remove deletes ComicInfo.xml, Replace writes the saved template, and Upgrade fills missing template fields. Replace and Upgrade require a global or manga-specific template. Policy failures are listed in Files Needing Attention and can be rechecked using the currently saved policy. Findings can be repaired, dismissed individually or in bulk as **Not an Issue**, or moved to the appropriate review workflow. Dismissals are tied to the file's current path and file state; a changed file can be checked again.

The saved ComicInfo policy is the library-wide default for incoming files, scheduled metadata maintenance, and QC repairs. Changing the selected policy does not immediately rewrite existing chapters; use **Apply selected ComicInfo policy to this manga** to run it against one manga now. The available modes are **Leave alone** (make no automatic metadata changes), **Update** (synchronize existing series/chapter identity fields), **Remove** (delete ComicInfo.xml), **Replace** (write the saved template), and **Upgrade** (fill missing template fields while preserving existing values). Replace and Upgrade require a global or manga-specific template. If a policy operation fails, the CBZ is listed in Files Needing Attention with the failed policy identified, and Recheck retries the currently saved policy rather than always removing XML.

Library Manager maintains a separate inventory of each destination manga folder. Filter the chapter inventory by regular chapters, Specials, whole-volume files, volume-assigned chapters, unparsed filenames, or duplicate chapter IDs. Numbered pagination, adjustable page sizes, and direct page navigation make large inventories easier to browse. Volume handling can be enabled per manga when a series is organized by volumes instead of—or alongside—chapters.

### Completed manga and missing-chapter alerts

When **Mark this manga as complete** is enabled, PanelKeeper first performs a fresh inventory of the accessible manga folder and saves the chapter identities that are present at that time. Later successful inventory scans compare the folder with that saved baseline. This detects chapters that disappear even when the missing chapter is beyond the highest remaining chapter number.

A folder that is missing or inaccessible is not treated as an empty manga, and an unsuccessful scan does not update the missing-chapter history. When a tracked chapter disappears, PanelKeeper can send a Home Assistant notification if a webhook is configured and **Missing chapters in completed manga** notifications are enabled in Settings. An alert is sent once for each disappearance episode; if the chapter returns and later disappears again, it can trigger another alert. Turning off the completed flag removes that series' completion baseline and restores normal replacement behavior.

## Chapter covers and Kavita

The standard cover workflow uses an image stored in the manga folder. Choose an existing image or import one from your computer, enable the local cover rule, and save it for the selected manga. PanelKeeper can insert that image as the first page of existing and future chapter CBZ files. Optional chapter-specific designs can add a chapter number, title, volume, or manga name to the local image. Neither workflow requires a Kavita connection.

When Kavita is connected, you can also use **Download Kavita Main Cover** to save its series cover as a normal image in the manga folder. That download does not enable Auto Cover, select the image, or modify any chapter CBZ. After downloading, choose the image from the local cover selector and apply it with the regular cover rule if you want to use it for chapter first pages.

Kavita Auto Cover is a separate optional integration. Enable it only when you want PanelKeeper to generate chapter-specific first pages from Kavita's main manga cover. Its setting and bulk-management controls do not replace the local image workflow. You can download a Kavita cover for manual use without enabling Auto Cover, or enable Auto Cover separately when you want generated chapter covers.

## Optional integrations

### Home Assistant notifications

Configure a full Home Assistant webhook URL in Settings, using the `/api/webhook/<webhook_id>` path. Enable the event types you want to receive. The webhook request contains a `message` field for compatibility with existing automations and can include event metadata, a timestamp, and a test identifier according to the notification preferences.

An HTTP success response means Home Assistant responded to the request; it does not confirm that a matching automation ran or that a notification was created. Home Assistant can return an HTTP success response even when a webhook ID does not match an active automation. To receive a persistent or mobile notification, create an automation that listens for the webhook and includes the desired notification action.

### Kavita

Kavita connection settings are optional. When configured, PanelKeeper can use Kavita-related series metadata and pull the main cover to support the available cover integration features. PanelKeeper does not replace Kavita as a reader or server.

## Data, backups, and security

PanelKeeper stores settings, mappings, inventory, review queues, Recovery records, cover rules, and logs in the main SQLite database. QC scan state and cache data are stored in a separate SQLite database. Back up **both** database files and the manga library before upgrading or making large batches of changes. Keep database files on storage that supports reliable SQLite locking; avoid placing active SQLite databases on unreliable network shares.

PanelKeeper can move, replace, modify, and delete files as part of library management. Recovery is available for supported replacement and removal workflows, but it is not a substitute for an independent backup.

**Security:** The application does not currently provide user authentication or multi-user access control. Run it only on a trusted machine or private network. Do not expose the web interface directly to the public internet. Use an appropriately secured VPN or authenticated reverse proxy if remote access is required.

