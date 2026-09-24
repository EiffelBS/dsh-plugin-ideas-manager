# Standardized About Section for Plugins with Options Panels

## Purpose

Every DSH plugin that exposes an options panel (`settings.section` slot) **must** include a standardized **About** section tab. This provides users with consistent metadata about the plugin and a mechanism to check for updates.

## Requirements

### 1. Reusable `AboutPanel` Component

The `AboutPanel` component lives in the shared library **`eiffelbs-ui`** (under `include/eiffelbs/AboutPanel.h`) and is exposed through `eiffelbs.h`. Plugins must **not** duplicate it — they import and use the shared version.

**Props interface** (C++ side):
```cpp
struct AboutPanelProps {
  std::string repositoryUrl;
  std::string version;
  std::string license;
  std::string compatibleVersions;
  std::function<void()> onCheckUpdate; // optional
};
```

**React/TypeScript equivalent** (`AboutPanelProps` in `src/client/about-panel.tsx`):
- `repositoryUrl: string` — link to the plugin's GitHub repository
- `version: string` — plugin version string
- `license: string` — license identifier (e.g. `"MIT"`, `"AGPL-3.0"`)
- `compatibleVersions: string` — compatible DSH version range
- `onCheckUpdate?: () => void` — optional callback for the "Check for updates" button

### 2. Plugin Integration

Plugins must register an `About` tab in their settings section page alongside the display options. The implementation pattern:

1. Register the settings section with `order: 60` in the `settings.section` slot
2. Render a tab navigation with at least `Display` and `About` tabs
3. Render `<AboutPanel {...props} />` in the About tab

See `src/client/settings-section.tsx` in the `dsh-plugin-ideas-manager` for the reference implementation.

### 3. Localization

The following keys must exist in **all** plugin locale dictionaries (`fr`, `en`, `zh`):
- `about.panelLabel` — accessible label for the About region
- `about.repository` — "Repository" label
- `about.version` — "Version" label
- `about.license` — "License" label
- `about.compatibleVersions` — "DSH compatibility" label
- `about.checkUpdate` — "Check for updates" button text
- `about.tabDisplay` — "Display" tab label
- `about.tabAbout` — "About" tab label

### 4. CSS Classes

The About panel must use the following scoped CSS classes (in `src/client/style.ts`):
- `.dsh-plugin-about-panel` — root region
- `.dsh-plugin-about-repo-link` — repository link
- `.dsh-plugin-about-details` — metadata container
- `.dsh-plugin-about-row` — individual metadata row
- `.dsh-plugin-about-label` — label text
- `.dsh-plugin-about-value` — value text
- `.dsh-plugin-about-check-update` — update button

### 5. Contributor Checklist

When contributing a plugin with an options panel:

- [ ] Plugin has a `settings.section` slot registration
- [ ] Settings page includes an **About** tab
- [ ] `<AboutPanel>` renders with real metadata from the plugin manifest
- [ ] All required locale keys are present in `fr`, `en`, and `zh`
- [ ] "Check for updates" button calls the `onCheckUpdate` callback (opens releases page)
- [ ] Unit tests cover rendering and update-button behavior
- [ ] The `AboutPanel` component is sourced from `eiffelbs-ui` (not duplicated)

## Reference Implementation

The `dsh-plugin-ideas-manager` (this repository) serves as the reference implementation:
- Component: `src/client/about-panel.tsx`
- Integration: `src/client/settings-section.tsx` (tab navigation + `<AboutPanel>`)
- Locales: `src/client/locales.ts`
- Styles: `src/client/style.ts` (`.dsh-plugin-about-*` classes)
- Tests: `tests/about-panel.test.tsx`

## DSH Compatibility

The About section works across DSH host settings contracts:
- `<= 0.1.5`: Settings are served via the legacy `/api/ideas/config` route
- `>= 0.1.7`: Settings are served via `SettingsForms` with a plugin-owned fallback

The `AboutPanel` is purely presentational and has no host-specific dependencies.

## Policy Notes

- **Never** run `dsh web` on port `3080` (that's the user session). Use `3099` or `3101` for test instances with a scratch `DSH_HOME`.
- **Never** `git push` without explicit approval.
- **All** documentation and code comments must be in English.
- Reusable UI components must be promoted to `eiffelbs-ui` — never duplicated across plugins.
