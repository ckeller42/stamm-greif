export const de = {
  siteName: 'Stamm-Greif-Archiv',
  nav: { archiv: 'Archiv', hochladen: 'Foto hochladen', zeitleiste: 'Zeitleiste', gesichter: 'Gesichter', kiosk: 'Kiosk', anmelden: 'Anmelden', abmelden: 'Abmelden' },
  login: { title: 'Anmelden', email: 'E-Mail', password: 'Passwort', submit: 'Anmelden', error: 'Anmeldung fehlgeschlagen' },
  invite: { title: 'Willkommen beim Stamm-Greif-Archiv', name: 'Dein Name', submit: 'Konto erstellen',
    invalid: 'Diese Einladung ist ungültig oder wurde bereits verwendet.',
    error: 'Das hat nicht geklappt — bitte prüfe deine Angaben und versuche es erneut.' },
  archiv: { title: 'Archiv', filterJahr: 'Jahr', filterGruppe: 'Gruppe', filterEreignis: 'Ereignis',
    filterOrt: 'Ort', filterPerson: 'Person', filterTag: 'Schlagwort', filtern: 'Filtern',
    alle: 'alle', empty: 'Keine Fotos gefunden.' },
  person: { gruppen: 'Gruppen', ereignisse: 'Ereignisse', fotos: 'Fotos',
    rollen: { mitglied: 'Mitglied', sippenfuehrer: 'Sippenführer', leiter: 'Leiter' } },
  event: { teilnehmer: 'Teilnehmer', fotos: 'Fotos', reihe: 'Teil der Reihe' },
  upload: { title: 'Fotos hochladen', hint: 'Was ist zu sehen? Welches Jahr? Wer ist drauf?',
    caption: 'Beschreibung (optional)', year: 'Jahr (optional)', submit: 'Hochladen',
    success: 'Danke! Deine Fotos werden von einem Kurator geprüft und dann veröffentlicht.',
    error: 'Hochladen fehlgeschlagen — bitte erneut versuchen.',
    formats: 'JPEG, PNG, TIFF, WebP, HEIC oder HEIF — iPhone-Fotos werden jetzt direkt unterstützt und beim Hochladen automatisch in JPEG umgewandelt.',
    duplicateWarning: 'Mögliches Duplikat eines vorhandenen Fotos',
    status: { wartet: 'wartet', laedt: 'lädt', fertig: 'fertig', fehler: 'fehler' } },
  gesichter: {
    title: 'Gesichter prüfen',
    hint: 'Wer ist das? Bestätigte Gesichter helfen dabei, dieselbe Person auf weiteren Fotos vorzuschlagen.',
    empty: 'Keine offenen Vorschläge.',
    disabled: 'Gesichtserkennung ist nicht aktiviert.',
    person: 'Person',
    choose: '(unbekannt)',
    similarity: 'Ähnlichkeit',
    confirm: 'Bestätigen',
    reject: 'Ablehnen',
    undo: 'Rückgängig',
    // Final review, M1: heading for the bestätigt list rendered alongside the offen queue on
    // /gesichter — the only place „Rückgängig" is actually reachable now.
    confirmedTitle: 'Bestätigte Gesichter',
    confirmedEmpty: 'Keine bestätigten Gesichter.',
    confirmedAs: 'Bestätigt als',
    saving: 'speichert',
    error: 'Das hat nicht geklappt — bitte erneut versuchen.',
    needsPerson: 'Bitte zuerst eine Person auswählen.',
    // Spec §7 irreversibility warning, third of the three places it's stated (admin-UI
    // description on People.hidden, here, betrieb.md) — final review, M4.
    irreversibleNotice:
      'Eine Person „verbergen" (unter Personen im Admin-Bereich) löscht deren Gesichtsdaten ' +
      'sofort und unwiderruflich — auch bereits bestätigte Vorschläge.',
  },
  kiosk: {
    invalid: 'Dieser Kiosk-Link ist ungültig oder abgelaufen.',
    empty: 'Zurzeit sind keine Fotos für den Kiosk freigegeben.',
    scanHint: 'Zum Herunterladen scannen',
  },
  kioskAdmin: {
    title: 'Kiosk-Links',
    hint: 'Erzeuge einen signierten Link für den Beamer/Kiosk. Der Link zeigt nur Fotos, die einzeln als „Für Kiosk freigegeben" markiert sind, und läuft nach der gewählten Gültigkeitsdauer automatisch ab.',
    label: 'Bezeichnung (optional)',
    hours: 'Gültig für (Stunden)',
    mint: 'Link erzeugen',
    open: 'Auf Beamer öffnen',
    copy: 'Kopieren',
    copied: 'Kopiert',
    revoke: 'Widerrufen',
    active: 'Aktive Links',
    expiresAt: 'Gültig bis',
    revoked: 'Widerrufen.',
    empty: 'Keine aktiven Kiosk-Links.',
    error: 'Das hat nicht geklappt — bitte erneut versuchen.',
  },
  zeitleiste: {
    title: 'Zeitleiste',
    chooseSeries: 'Reihe wählen',
    noSeries: 'Keine Ereignisreihen vorhanden.',
    emptyYear: 'Keine Fotos für dieses Ereignis.',
    jahr: 'Jahr',
  },
  photos: {
    kioskFreigegeben: {
      label: 'Für Kiosk freigegeben',
      help: 'Nur für den öffentlichen Beamer/Kiosk freigeben, was wirklich öffentlich gezeigt ' +
        'werden darf. Niemals Fotos von Minderjährigen oder mitglieder-interne Fotos markieren — ' +
        'der Kiosk ist ohne Anmeldung sichtbar. Verborgene, unveröffentlichte oder gelöschte ' +
        'Fotos erscheinen ohnehin nie, auch wenn sie hier markiert sind.',
    },
  },
} as const
