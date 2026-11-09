/* Arabic dictionary. Key = exact English source text, value = Arabic.
   Plural entries are objects keyed by Intl.PluralRules('ar') forms: zero, one, two, few, many, other.
   Follow GLOSSARY.md: "Taskitator" stays Latin; Universe = يونيفيرس; Copilot = المساعد الذكي; Pro = برو.
   Placeholders like {n} and {name} must appear unchanged in the Arabic text (i18n.test.js checks it).
   Never add rule/variable syntax here: {title==…} variables and operators stay English. */
(function () {
    'use strict';
    const ar = {
        // ----- Glossary terms -----
        'Universe': 'يونيفيرس',
        'Copilot': 'المساعد الذكي',
        'Focus Copilot': 'المساعد الذكي',
        'Pro': 'برو',
        'PRO': 'برو',
        'Max': 'ماكس',
        'Shield': 'محمي',
        'Bonus': 'إضافية',
        'Bonus task': 'مهمة إضافية',
        'Scratchpad': 'خازنة الأفكار',
        'Sleep Lock': 'قفل النوم',
        'Emergency': 'طوارئ',
        'Inbox': 'الافتراضي',
        'Credits': 'الرصيد',

        // ----- Navigation drawer -----
        'Today': 'اليوم',
        'General Tasks': 'المهام العامة',
        'Calendar': 'التقويم',
        'Projects': 'المشاريع',
        'Stats': 'الإحصائيات',
        'Trash': 'المحذوفات',
        'Drafts': 'المسودات',
        'Help': 'المساعدة',
        'Settings': 'الإعدادات',
        'Recurring tasks': 'المهام المتكررة',
        'Menu': 'القائمة',
        'Open Navigation Drawer': 'فتح قائمة التنقل',

        // ----- Header -----
        'Completed': 'المكتملة',
        'Completed Tasks': 'المهام المكتملة',
        'View Completed Tasks': 'عرض المهام المكتملة',
        'Breaks': 'الاستراحات',
        'Daily Breaks': 'الاستراحات اليومية',
        'Manage Daily Breaks': 'إدارة الاستراحات اليومية',
        'Emergency bypass': 'تجاوز الطوارئ',
        'Emergency Bypass': 'تجاوز الطوارئ',
        'Multiselect': 'تحديد متعدد',
        'Toggle Multi-Selection Mode': 'تبديل وضع التحديد المتعدد',
        'Filter': 'تصفية',
        'Filter Tasks': 'تصفية المهام',
        'Sort tasks': 'ترتيب المهام',
        'New task': 'مهمة جديدة',
        'Create task': 'إنشاء مهمة',
        'Create Task': 'إنشاء مهمة',
        'Set username': 'تعيين اسم المستخدم',
        'Send': 'إرسال',

        // ----- Settings → General → Language (language-ui in appearance-ui.js) -----
        'Language': 'اللغة',
        'Saved on this device only. Your other devices keep their own choice.': 'تُحفظ على هذا الجهاز فقط. تحتفظ أجهزتك الأخرى باختيارها.',
        'App language': 'لغة التطبيق',
        'Changing the language reloads the page. Your tasks, AI and sync work the same in every language.': 'تغيير اللغة يعيد تحميل الصفحة. تعمل مهامك والذكاء الاصطناعي والمزامنة بنفس الطريقة في كل لغة.',
        'Time format': 'تنسيق الوقت',
        'Automatic': 'تلقائي',
        '12-hour': '12 ساعة',
        '24-hour': '24 ساعة',
        'Automatic uses 12-hour in Arabic and each screen\'s usual format in English.': 'التلقائي يستخدم نظام 12 ساعة في العربية والتنسيق المعتاد لكل شاشة في الإنجليزية.',
        'General': 'عام',
        'Colour theme': 'لون السمة',
        'Appearance': 'المظهر'
    };
    window.TaskitatorI18n?.register('ar', ar);
    if (typeof module === 'object' && module.exports) module.exports = ar;

})();
