// Migration-only type augmentation — allows common DOM properties on HTMLElement
// Remove this when proper typing is added

interface HTMLElement {
  value: any;
  checked: any;
  src: any;
  href: any;
  files: any;
  selectedIndex: any;
  options: any;
  type: any;
  name: any;
  min: any;
  max: any;
  step: any;
  placeholder: any;
  readOnly: any;
  disabled: any;
  selected: any;
  multiple: any;
  accept: any;
  required: any;
  width: any;
  height: any;
  naturalWidth: any;
  naturalHeight: any;
  complete: any;
  selectionStart: any;
  selectionEnd: any;
  setSelectionRange: any;
  select: any;
  focus: any;
}

interface Element {
  value: any;
  dataset: DOMStringMap;
  src: any;
  href: any;
  checked: any;
}

interface Window {
  [key: string]: any;
}
