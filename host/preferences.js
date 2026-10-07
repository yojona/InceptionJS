// view.preferences: what the page sees as the user's settings. Each field is
// a value or "auto"; "auto" follows the host browser and its changes.
//
//   colorScheme: "light" | "dark"        prefers-color-scheme, native controls
//   reducedMotion: boolean               prefers-reduced-motion
//   contrast: "more" | "no-preference"   prefers-contrast
//   languages: string[]                  navigator.languages, Accept-Language
//   timeZone: IANA name                  Date and Intl

export const PREFERENCE_DEFAULTS = { colorScheme: 'auto', reducedMotion: 'auto', contrast: 'auto', languages: 'auto', timeZone: 'auto' };

const queries = {
  colorScheme: ['(prefers-color-scheme: dark)', (dark) => (dark ? 'dark' : 'light')],
  reducedMotion: ['(prefers-reduced-motion: reduce)', (reduce) => reduce],
  contrast: ['(prefers-contrast: more)', (more) => (more ? 'more' : 'no-preference')],
};

function hostValue(name) {
  if (queries[name]) {
    const [query, map] = queries[name];
    return map(matchMedia(query).matches);
  }
  if (name === 'languages') return [...(navigator.languages?.length ? navigator.languages : [navigator.language])];
  if (name === 'timeZone') return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export class Preferences {
  #settings = { ...PREFERENCE_DEFAULTS };
  #send;

  // `send(values)` receives the resolved values whenever they change.
  constructor(send) {
    this.#send = send;
    for (const [name, [query]] of Object.entries(queries))
      matchMedia(query).addEventListener('change', () => this.#changed(name));
    addEventListener('languagechange', () => this.#changed('languages'));
    // Time zones change without an event; travel is rare enough for a minute.
    setInterval(() => this.#changed('timeZone'), 60_000);
    this.last = this.resolved();
  }

  get settings() { return { ...this.#settings }; }

  set(values) {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (!(name in PREFERENCE_DEFAULTS)) throw new TypeError(`unknown preference "${name}"`);
      this.#settings[name] = value ?? 'auto';
    }
    this.#publish();
  }

  resolved() {
    const values = {};
    for (const [name, value] of Object.entries(this.#settings)) values[name] = value === 'auto' ? hostValue(name) : value;
    return values;
  }

  #changed(name) {
    if (this.#settings[name] === 'auto') this.#publish();
  }

  #publish() {
    const values = this.resolved();
    const changed = {};
    for (const [name, value] of Object.entries(values))
      if (JSON.stringify(value) !== JSON.stringify(this.last[name])) changed[name] = value;
    this.last = values;
    if (Object.keys(changed).length) this.#send(changed);
  }
}
