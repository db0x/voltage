const { app } = require('electron')

const translations = {
  de: require('./i18n/de.json'),
  en: require('./i18n/en.json'),
}

function t() {
  const lang = (process.env.VOLTAGE_LANG ?? app.getLocale()).split('-')[0].toLowerCase()
  return translations[lang] ?? translations.en
}

module.exports = { t }
