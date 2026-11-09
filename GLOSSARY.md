# Arabic glossary (locked)

Every Arabic string in `locales/ar.js` must follow this table. `i18n.test.js` enforces the fixed terms.

## Fixed terms
| English | Arabic | Rule |
|---|---|---|
| Taskitator | Taskitator | Never translated. Stays Latin in every language. |
| Universe | يونيفيرس | Proper noun. No "ال", no inflection. |
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
| Macro / `.macro` files | Latin | External automation app. |

## Rules
- User input is never translated, inspected or gendered: task titles, tags, project names and icons, notes, Copilot name, Copilot replies.
- Rule and variable syntax stays English. `{title==الاحياء}` works; `{عنوان==الاحياء}` does not. Variable names and operators are never translated; only typed values can be Arabic.
- Dates are Gregorian only. Digits are Western (0-9) only.
- Time is 12h or 24h, chosen by the user (Settings → General → Language). "Automatic" keeps each screen's original English behaviour, and uses 12h (ص/م) in Arabic.
- The language is saved on this device only (`taskitator_lang`), English by default, never synced, and never sent to the server. The backend behaves the same in both languages.
- Arabic UI is right-to-left: the sidebar is on the right and the المساعد الذكي panel on the left.
