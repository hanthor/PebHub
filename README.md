# PebHub

An unofficial GitHub client for Pebble Smartwatch, rewritten in **Alloy** (Moddable JavaScript SDK) with CI monitoring and notifications.

Runs on **Pebble Time 2** ("emery") and **Pebble Round 2** ("gabbro").

## Features

- **Notification Feed** — Browse GitHub notifications (Issues, PRs, CI checks, and more) on your wrist
- **CI Dashboard** — Monitor GitHub Actions workflow runs: status, branch, duration at a glance
- **Background Polling** — Fetches new notifications every 5 minutes, vibrates on CI failures
- **OAuth Device Flow** — Authenticate without typing a token on the watch
- **Config-compatible with Cinders** — Same field names as `daegalus/cinders` GSettings schema (`forge`, `url`, `auth-method`, `excluded-repositories`, `notifTypes`)

## Screenshots

| Notification Feed | CI Dashboard | Detail Card |
|---|---|---|
| _(screenshots TBD)_ | | |

## Requirements

- Pebble Time 2 (emery) or Pebble Round 2 (gabbro) running PebbleOS
- [Pebble SDK 4.17+](https://developer.repebble.com/) with Moddable/Alloy support
- GitHub personal access token with `notifications` and `read:user` scopes (or OAuth Device Flow)

## Setup

### Install Pebble SDK

```bash
# Install pebble-tool
uv tool install pebble-tool --python 3.12

# Install the latest SDK
pebble sdk install latest
```

### Build and Install

```bash
# Clone the repo
git clone https://github.com/hanthor/PebHub
cd PebHub

# Build for all platforms
pebble build

# Install on your watch over WiFi
pebble install --phone 192.168.0.11

# Or install in emulator
pebble install --emulator emery
```

### Configuration

1. Open PebHub on your watch
2. Press SELECT to start OAuth Device Flow (or configure via the Pebble phone app)
3. Enter the displayed code at https://github.com/login/device on your phone
4. Configure notification types and excluded repos from the Pebble app settings

## Architecture

```
src/
├── embeddedjs/
│   ├── manifest.json          # Moddable module manifest
│   └── main.js                # App entry: screens, GitHub API, OAuth, polling
└── pkjs/
    └── index.js               # Phone-side message bridge + config page handler

config/
└── index.html                 # Config page (packaged, opened on phone)

package.json                   # Project metadata and Pebble manifest
```

### Config Schema (Cinders-compatible)

| Field | Type | Description |
|---|---|---|
| `forge` | string | "github", "gitlab", "gitea", "forgejo" |
| `url` | string | Instance URL (default: "github.com") |
| `authMethod` | string | "token" or "oauth" |
| `token` | string | Personal access token |
| `excludedRepos` | string[] | Excluded repos (same format as Cinders) |
| `notifTypes` | string[] | Notification types to show |
| `pollInterval` | number | Poll interval in seconds (default: 300) |
| `maxNotifications` | number | Max notifications to fetch (default: 50) |
| `maxCiRuns` | number | Max CI runs to display (default: 10) |

## Development

### Resources

- [Alloy Getting Started Guide](https://developer.repebble.com/guides/alloy/getting-started/)
- [Moddable SDK Documentation](https://www.moddable.com/documentation/)
- [Pebble Examples](https://github.com/Moddable-OpenSource/pebble-examples)
- [Cinders (config schema reference)](https://github.com/daegalus/cinders)

## License

MIT
