# Accessibility & Localization — BlackStack CRM

## Accessibility (implemented)

Targeted, verified improvements — not a full WCAG audit:

- **Keyboard**: Settings tabs and all buttons are native `<button>`s (Tab,
  Shift+Tab, Enter/Space). Update-channel selector uses a real radio group
  (`role="radiogroup"`, arrow-key navigable).
- **Focus**: browser-native focus rings remain visible on all controls.
- **Labels & headings**: Data Safety sections use `aria-labelledby` with real
  heading elements; destructive actions have descriptive labels ("Delete All
  Data…", "Restore Backup", "Cancel Restore") instead of ambiguous OK/Yes.
- **Dialogs**: restore and delete flows use the existing Modal component with
  a Cancel button; Escape/close supported by the component.
- **Errors**: update/restore/deletion failures are announced via the existing
  Toast + inline status text (`role="status"` on storage warnings).

Known gaps (honest): no dedicated screen-reader pass, no full contrast audit
of every custom color pair, drag-and-drop-only interactions (if any) not yet
given keyboard alternatives.

## Localization (architecture)

- Status: **architecture prepared; only English is complete.**
- User-facing strings currently live in `public/js` modules (English).
- The update-channel selector and Data Safety panel copy new strings are
  centralized where practical to ease future extraction.
- **Malayalam / Hindi: NOT shipped.** They are not translated or tested; the
  installer UI is English (electron-builder default). Claiming support before
  full translation + QA would violate the documentation-accuracy rule.

Planned (Phase 4): string extraction into a dictionary module
(`en/ml/hi`), language preference in Settings, installer language selection.
