import { generatedTools } from "./tools.js";

/**
 * Firefly III MCP Tool Presets
 * 
 * This file defines presets for Firefly III MCP tools.
 */

/**
 * All available tool tags in Firefly III API
 */
export const RAW_TOOL_TAG = "raw";

export const ALL_TOOL_TAGS = [
  ...new Set(generatedTools.flatMap((tool) => tool.tags)),
  RAW_TOOL_TAG,
];

/**
 * Default preset tags used in core package
 */
export const DEFAULT_PRESET_TAGS = [
  "accounts",
  "bills",
  "categories",
  "tags",
  "transactions",
  "search",
  "summary",
];

/**
 * Tool presets for Firefly III MCP
 */
export const TOOL_PRESETS: Record<string, string[]> = {
  // Default preset - uses core package default tags
  "default": DEFAULT_PRESET_TAGS,
  
  // Full preset - includes all available tags
  "full": ALL_TOOL_TAGS,
  
  // Basic financial management preset
  "basic": [
    "accounts",
    "transactions",
    "categories",
    "tags",
    "search",
    "summary",
  ],
  
  // Budget-focused preset
  "budget": [
    "accounts",
    "budgets",
    "available_budgets",
    "categories",
    "transactions",
    "summary",
    "insight",
  ],
  
  // Reporting and analysis preset
  "reporting": [
    "accounts",
    "transactions",
    "categories",
    "charts",
    "insight",
    "summary",
    "search",
  ],
  
  // Administration preset
  "admin": [
    "about",
    "configuration",
    "currencies",
    "users",
    "user_groups",
    "preferences",
  ],
  
  // Automation preset
  "automation": [
    "rules",
    "rule_groups",
    "recurrences",
    "webhooks",
    "transactions",
  ],
};

/**
 * Get tool tags for a preset
 * @param preset Preset name
 * @returns Array of tool tags
 */
export function getPresetTags(preset: string): string[] {
  return TOOL_PRESETS[preset.toLowerCase()] || DEFAULT_PRESET_TAGS;
}

/**
 * Check if a preset exists
 * @param preset Preset name
 * @returns True if preset exists
 */
export function presetExists(preset: string): boolean {
  return preset.toLowerCase() in TOOL_PRESETS;
}

/**
 * Get all available preset names
 * @returns Array of preset names
 */
export function getAvailablePresets(): string[] {
  return Object.keys(TOOL_PRESETS);
} 