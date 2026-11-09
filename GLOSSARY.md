# Arabic glossary (locked)

Every Arabic string in `locales/ar.js` must follow this table. `i18n.test.js` enforces the fixed terms.

## Fixed terms
| English | Arabic | Rule |
|---|---|---|
| Taskitator | Taskitator | Never translated. Stays Latin in every language. |
| Universe | يونيفيرس | Proper noun. No "ال", no inflection. Plural (Universes) = مساحات يونيفيرس. "This Universe" = يونيفيرس هذا. |
| Copilot / Co-pilot / Focus Copilot (default name) | المساعد الذكي | A user-chosen Copilot name is user input and is shown as typed. |
| Pro | برو | e.g. "ميزة برو", "ترقية إلى برو". |
| Max | ماكس | Tier, same treatment as Pro. |
| Shield | محمي | |
| Bonus (task) | إضافية | Feminine, because the noun is مهمة (مهمة إضافية). Chosen per string in the dictionary, never at runtime. |
| Scratchpad | خازنة الأفكار | |
| Sleep Lock | قفل النوم | Plain "Sleep" is النوم. |
| Emergency | طوارئ | |
| Inbox (default project) | الافتراضي | |
| Credits (AI) | الرصيد | |
| Keyo, Clerk, Gemini, Anthropic | Latin | Vendor names. |
| Macro / `.macro` files | Latin | External automation app. MacroDroid's own menu and button names stay English in the guides, because that is what the user sees in MacroDroid. |
| Universe roles | مالك / مشرف / مراجع / عضو | owner / admin / reviewer / member |
| Universe tabs Joined / Created | انضممت إليها / أنشأتها | |
| Durations | 2س 30د | س = hours, د = minutes (English keeps 2h 30m) |

## Rules
- User input is never translated, inspected or gendered: task titles, tags, project names and icons, notes, Copilot name, Copilot replies.
- Rule and variable syntax stays English. `{title==الاحياء}` works; `{عنوان==الاحياء}` does not. Variable names and operators are never translated; only typed values can be Arabic.
- Dates are Gregorian only. Digits are Western (0-9) only.
- Time is 12h or 24h, chosen by the user (Settings → General → Language). "Automatic" keeps each screen's original English behaviour, and uses 12h (ص/م) in Arabic.
- The language is saved on this device only (`taskitator_lang`), English by default, never synced, and never sent to the server. The backend behaves the same in both languages.
- Arabic UI is right-to-left: the sidebar is on the right and the المساعد الذكي panel on the left.

## Not translated (on purpose)
- Privacy Policy and Terms: English is the binding text. Arabic shows a one-line notice above them.
- Help page: second release. Its content stays English and left-to-right, with a one-line Arabic notice.
- Server error messages that have no dictionary entry show in English (the backend never changes by language).
- The default tag names in a new workspace (personal, work…) are user data.

## Adding or fixing a translation
Edit `locales/ar.js` (key = exact English text). To list untranslated text: in the browser console run
`sessionStorage.setItem('taskitator_i18n_debug','1')`, reload in Arabic, use the screens, then `TaskitatorI18n.missing()`.
New code needs nothing special: rendered text is translated by exact match or a `{0}` pattern entry.
Mark user content with `translate="no"` so it is never touched.
