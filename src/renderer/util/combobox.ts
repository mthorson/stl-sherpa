/**
 * True when a Mantine combobox (Autocomplete) has a dropdown option
 * highlighted. Raw Enter handlers must skip submitting in that case:
 * Mantine is about to deliver the highlighted option via onOptionSubmit,
 * and submitting the typed prefix too would double-submit (e.g. create
 * both "mini" and "miniatures").
 */
export function hasActiveComboboxOption(e: React.KeyboardEvent): boolean {
  return Boolean((e.target as HTMLElement).getAttribute('aria-activedescendant'));
}
