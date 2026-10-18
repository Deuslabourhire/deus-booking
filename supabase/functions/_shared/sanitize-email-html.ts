// Allow-list sanitiser for HTML written in the Admin page (client invoices, booking links).
// Everything not listed below is removed: scripts, styles blocks, SVG/MathML, forms, frames,
// event attributes (onclick, onerror, ...), id/class, and any URL that is not https (images)
// or https/mailto (links). Inline styles are kept only for listed properties, and a value
// is refused if it could load or run anything (url(), expression, @import, javascript, ...).
import sanitizeHtml from "sanitize-html";   // pinned in deno.json (npm:sanitize-html@2.18.0)

const TAGS = [
  "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "small", "center",
  "h1", "h2", "h3", "h4", "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "img", "a",
];

const STYLE_PROPS = [
  "color", "background", "background-color", "font-family", "font-size", "font-style", "font-weight",
  "text-align", "text-transform", "text-decoration", "letter-spacing", "line-height", "vertical-align", "white-space",
  "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
  "padding", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "border", "border-top", "border-bottom", "border-left", "border-right", "border-radius", "border-collapse",
  "width", "max-width", "min-width", "height", "display", "align-items", "justify-content", "gap",
  "flex", "flex-shrink", "grid-template-columns", "overflow",
];
// Colours, sizes, keywords, quoted font names and gradients only. No url(), no escapes.
const SAFE_VALUE = /^(?!.*\b(url|expression|image-set|image|element|var|attr|env)\s*\()[-\w\s#%.,'"()/!]*$/i;
const STYLES: Record<string, RegExp[]> = Object.fromEntries(STYLE_PROPS.map((p) => [p, [SAFE_VALUE]]));
const LAYOUT_ATTRS = ["style", "align", "valign", "width", "height", "colspan", "rowspan", "cellpadding", "cellspacing", "border", "bgcolor"];

const OPTIONS = {
  allowedTags: TAGS,
  allowedAttributes: { "*": LAYOUT_ATTRS, a: [...LAYOUT_ATTRS, "href", "title"], img: [...LAYOUT_ATTRS, "src", "alt"] },
  allowedSchemes: ["https", "mailto"],
  allowedSchemesByTag: { img: ["https"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  allowedStyles: { "*": STYLES },
  disallowedTagsMode: "discard" as const,
  // Text inside these is dropped together with the tag.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "svg", "math", "template", "iframe", "object"],
  parseStyleAttributes: true,
};

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}
