import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type GSyncPlugin from "./main";
import { DEFAULT_REDIRECT } from "./auth";

const DONATE_URL = "https://www.paypal.com/donate/?hosted_button_id=N8NVQRB353E2G";

export interface GSyncSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
  remoteFolder: string;
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  propagateDeletes: boolean;
  excludes: string;
  maxFileSizeMB: number;
}

export const DEFAULT_SETTINGS: GSyncSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  redirectUri: DEFAULT_REDIRECT,
  remoteFolder: "",
  autoSyncMinutes: 10,
  syncOnStartup: true,
  propagateDeletes: true,
  excludes: "# One rule per line. Hidden files/folders and the vault config folder are always skipped.\n# Examples:  Templates/   *.tmp   desktop.ini\ndesktop.ini\nThumbs.db\n",
  maxFileSizeMB: 25,
};

export class GSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GSyncPlugin) {
    super(app, plugin);
  }

  /** Legacy Obsidian (<1.13): reuse the same settings definitions and handlers. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const group of this.getSettingDefinitions()) {
      if (!("type" in group) || group.type !== "group") continue;
      if (group.heading) new Setting(containerEl).setName(group.heading).setHeading();
      for (const row of group.items ?? []) {
        if (!("name" in row)) continue;
        const setting = new Setting(containerEl).setName(row.name);
        if (row.desc) setting.setDesc(row.desc);
        if ("render" in row && row.render) {
          // Legacy callbacks only use Setting; the new API also passes SettingGroup.
          const renderLegacy = row.render as (setting: Setting) => void;
          renderLegacy(setting);
        }
      }
    }
  }

  /** Refresh either the declarative (1.13+) or legacy settings UI. */
  refresh(): void {
    if (typeof this.update === "function") this.update();
    else this.display();
  }

  // Reuse the same render callbacks on old and new Obsidian versions.
  // This is also called for search indexing; no network or DOM work until render.
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        type: "group",
        heading: "Google account",
        items: [
          {
            name: "OAuth client ID",
            desc: "From Google Cloud Console: Credentials, OAuth client ID (type: Web application).",
            render: (setting) => {
              void this.plugin.prepareSignInLink();
              setting.addText((t) =>
                t.setValue(s.clientId).onChange(async (v) => {
                  s.clientId = v.trim();
                  await this.plugin.saveAll();
                  void this.plugin.prepareSignInLink();
                })
              );
            },
          },
          {
            name: "OAuth client secret",
            render: (setting) => {
              setting.addText((t) => {
                t.inputEl.type = "password";
                t.setValue(s.clientSecret).onChange(async (v) => {
                  s.clientSecret = v.trim();
                  await this.plugin.saveAll();
                });
              });
            },
          },
          {
            name: "Status",
            desc: s.refreshToken ? "Signed in." : "Not signed in.",
            render: (status) => {
              status.addButton((b) =>
                b
                  .setButtonText(s.refreshToken ? "Sign in again" : "Sign in with Google")
                  .setCta()
                  .onClick(() => {
                    if (!s.clientId || !s.clientSecret) {
                      new Notice("Enter the client ID and secret first.");
                      return;
                    }
                    this.plugin.startSignIn();
                  })
              );
              if (s.refreshToken) {
                status.addButton((b) =>
                  b.setButtonText("Copy refresh token").onClick(async () => {
                    await navigator.clipboard.writeText(s.refreshToken);
                    new Notice("Refresh token copied. Keep it private.");
                  })
                );
                status.addButton((b) =>
                  b.setButtonText("Sign out").onClick(async () => {
                    s.refreshToken = "";
                    this.plugin.setAccessToken("", 0);
                    await this.plugin.saveAll();
                    this.refresh();
                  })
                );
              }
            },
          },
          {
            name: "Refresh token (manual)",
            desc: "Optional. Paste a token from another device instead of signing in here.",
            render: (setting) => {
              setting.addText((t) => {
                t.inputEl.type = "password";
                t.setValue(s.refreshToken).onChange(async (v) => {
                  s.refreshToken = v.trim();
                  this.plugin.setAccessToken("", 0);
                  await this.plugin.saveAll();
                });
              });
            },
          },
          {
            name: "Sign-in redirect page",
            desc: "Must exactly match an authorized redirect URI on your OAuth client. Leave the default unless you host your own copy of callback.html.",
            render: (setting) => {
              setting.addText((t) =>
                t.setValue(s.redirectUri).onChange(async (v) => {
                  s.redirectUri = v.trim() || DEFAULT_REDIRECT;
                  await this.plugin.saveAll();
                  void this.plugin.prepareSignInLink();
                })
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Sync",
        items: [
          {
            name: "Sync now",
            desc: 'Also available from the ribbon icon and the command palette ("GSync: Sync now").',
            render: (setting) => {
              setting.addButton((b) =>
                b
                  .setButtonText("Sync now")
                  .setCta()
                  .onClick(async () => {
                    b.setDisabled(true).setButtonText("Syncing…");
                    try {
                      await this.plugin.sync(false);
                    } finally {
                      b.setDisabled(false).setButtonText("Sync now");
                    }
                  })
              );
            },
          },
          {
            name: "Google Drive folder",
            desc: 'Path under "My Drive", for example Obsidian/notes. Created if it does not exist.',
            render: (setting) => {
              setting.addText((t) =>
                t.setValue(s.remoteFolder).onChange(async (v) => {
                  const next = v.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
                  if (next !== s.remoteFolder) this.plugin.state = {};
                  s.remoteFolder = next;
                  await this.plugin.saveAll();
                })
              );
            },
          },
          {
            name: "Auto-sync every (minutes)",
            desc: "Set to 0 to turn auto-sync off.",
            render: (setting) => {
              setting.addText((t) =>
                t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
                  s.autoSyncMinutes = Math.max(0, parseInt(v, 10) || 0);
                  await this.plugin.saveAll();
                  this.plugin.scheduleAutoSync();
                })
              );
            },
          },
          {
            name: "Sync when Obsidian starts",
            render: (setting) => {
              setting.addToggle((t) =>
                t.setValue(s.syncOnStartup).onChange(async (v) => {
                  s.syncOnStartup = v;
                  await this.plugin.saveAll();
                })
              );
            },
          },
          {
            name: "Sync deletions",
            desc: "Deleting a note on one side moves it to the trash on the other (Google Drive trash / Obsidian trash). When off, deleted files come back on the next sync.",
            render: (setting) => {
              setting.addToggle((t) =>
                t.setValue(s.propagateDeletes).onChange(async (v) => {
                  s.propagateDeletes = v;
                  await this.plugin.saveAll();
                })
              );
            },
          },
          {
            name: "Max file size (MB)",
            desc: "Larger files are skipped (listed in the sync notice). Keeps phones from running out of memory. 0 = no limit.",
            render: (setting) => {
              setting.addText((t) =>
                t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
                  s.maxFileSizeMB = Math.max(0, parseInt(v, 10) || 0);
                  await this.plugin.saveAll();
                })
              );
            },
          },
          {
            name: "Exclude",
            desc: "Folder/ prefixes, *.ext patterns, or exact file names.",
            render: (setting) => {
              setting.addTextArea((t) => {
                t.inputEl.rows = 6;
                t.setValue(s.excludes).onChange(async (v) => {
                  s.excludes = v;
                  await this.plugin.saveAll();
                });
              });
            },
          },
          {
            name: "Reset sync state",
            desc: "Forgets what was synced. Next sync compares every file by content; nothing is deleted.",
            render: (setting) => {
              setting.addButton((b) =>
                b.setButtonText("Reset").onClick(async () => {
                  this.plugin.state = {};
                  await this.plugin.saveAll();
                  new Notice("Sync state reset.");
                })
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Support",
        items: [
          {
            name: "Support GSync",
            desc: "GSync is free and open source. If it saves you a subscription, you can chip in to support development.",
            render: (setting) => {
              setting.addButton((b) =>
                b.setButtonText("Donate via PayPal").onClick(() => {
                  window.open(DONATE_URL);
                })
              );
            },
          },
        ],
      },
    ];
  }
}
