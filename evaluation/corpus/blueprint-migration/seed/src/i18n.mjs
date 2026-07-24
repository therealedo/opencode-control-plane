export const catalogs = Object.freeze({
  en: Object.freeze({ greeting: "Hello", follow_up: "Follow up" }),
})

export function translate(locale, key) {
  return catalogs[locale]?.[key] ?? catalogs.en[key] ?? key
}
