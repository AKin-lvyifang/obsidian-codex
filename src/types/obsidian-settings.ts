import type { Setting, SettingGroup as LegacySettingGroup } from "obsidian";

/** Public in the 1.13 API; missing from the published 1.12 type declaration. */
export interface SettingGroup extends LegacySettingGroup {
  listEl: HTMLElement;
}

/**
 * Type-only subset of Obsidian's public 1.13.2 settings API.
 * The npm package currently provides 1.12.3 types. Keep these shapes aligned
 * with obsidianmd/obsidian-api@cc1744324150c632416857c98964f87b1574a5fc.
 * No new runtime exports are imported, so the 1.11.4 display fallback remains usable.
 */
export interface SettingDefinitionRender {
  name: string;
  desc?: string | DocumentFragment;
  aliases?: string[];
  searchable?: boolean | (() => boolean);
  visible?: boolean | (() => boolean);
  control?: never;
  action?: never;
  render: (setting: Setting, group: SettingGroup) => void | (() => void);
}

/** The group shape used by EchoInk; its children are all custom-rendered rows. */
export interface SettingsCategoryGroupDefinition {
  type: "group";
  cls?: string;
  items: SettingDefinitionRender[];
}
