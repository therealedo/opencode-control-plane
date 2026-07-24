export const catalogs = Object.freeze({
  en: Object.freeze({ greeting: "Hello", follow_up: "Follow up" }),
  es: Object.freeze({ greeting: "Hola", follow_up: "Seguimiento" }),
})

export function translate(locale, key) {
  return catalogs[locale]?.[key] ?? catalogs.en[key] ?? key
}
