import type { SettingsLanguage } from "../settings/settings";

const MESSAGE_HEADER_TIME_FORMATTERS: Record<SettingsLanguage, Intl.DateTimeFormat> = {
  "zh-CN": new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }),
  en: new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  })
};

export function formatMessageHeaderTime(
  value: number,
  language: SettingsLanguage = "zh-CN"
): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const formatted = MESSAGE_HEADER_TIME_FORMATTERS[language].format(new Date(value));
  return language === "en" ? formatted : formatted.replace(/\s+/g, "");
}
