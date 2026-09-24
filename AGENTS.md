# Local Cue configuration

- Before changing local settings, run `node scripts/cue-config.js status` in this repository.
- Resolve the active directory from the ignored `cue-local.json` locator (or an explicit `CUE_DATA_DIR` test override). Do not assume that `%APPDATA%`, a Bash home directory, or a sandbox mirror is the running app's directory.
- Compare the reported path and saved provider names with Settings → Keys in the running app. A blank field or a missing key in another environment does not establish that the key was deleted.
- Never print API key values or the entire settings file. Keep local settings, profile exports, and backups out of Git.
- To load preparation material, quit Cue and use `node scripts/cue-config.js import-profile <profile.json>`. This imports only preparation/style fields, preserves credentials and model configuration, and backs up the prior file.
- The app rejects saves from stale settings windows. Use Reload saved settings to refresh after an import.
- Local packaged builds include the locator when it exists. Do not distribute a machine-specific build as a generic public release.
