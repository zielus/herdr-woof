/* @ds-bundle: {"format":4,"namespace":"WoofDesignSystem_3b6aec","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Checkbox","sourcePath":"components/core/Checkbox.jsx"},{"name":"Chip","sourcePath":"components/core/Chip.jsx"},{"name":"Dialog","sourcePath":"components/core/Dialog.jsx"},{"name":"Hash","sourcePath":"components/core/Hash.jsx"},{"name":"ICON_PATHS","sourcePath":"components/core/Icon.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"JournalLine","sourcePath":"components/core/JournalLine.jsx"},{"name":"KeyValue","sourcePath":"components/core/KeyValue.jsx"},{"name":"Logo","sourcePath":"components/core/Logo.jsx"},{"name":"Select","sourcePath":"components/core/Select.jsx"},{"name":"Switch","sourcePath":"components/core/Switch.jsx"},{"name":"Table","sourcePath":"components/core/Table.jsx"},{"name":"Tabs","sourcePath":"components/core/Tabs.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Timeline","sourcePath":"components/core/Timeline.jsx"},{"name":"Toast","sourcePath":"components/core/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/core/Tooltip.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"e86a7dfcce0a","components/core/Button.jsx":"9b9d74ba51a4","components/core/Card.jsx":"ade6b9863c74","components/core/Checkbox.jsx":"27dee4fd538a","components/core/Chip.jsx":"760dcd323a83","components/core/Dialog.jsx":"edfee09b1716","components/core/Hash.jsx":"afadb2211ae7","components/core/Icon.jsx":"2ba804c346bb","components/core/IconButton.jsx":"5276b677e09a","components/core/Input.jsx":"a87ddeac7361","components/core/JournalLine.jsx":"b43a39f3a061","components/core/KeyValue.jsx":"bf6c75e9444e","components/core/Logo.jsx":"64f4bb88d887","components/core/Select.jsx":"5eef63814b40","components/core/Switch.jsx":"6fd198629348","components/core/Table.jsx":"2be199e4dc15","components/core/Tabs.jsx":"e6d8fb38936b","components/core/Tag.jsx":"4845c5398e86","components/core/Timeline.jsx":"b4a597ad3d7d","components/core/Toast.jsx":"4b5a7918894e","components/core/Tooltip.jsx":"b2d660e60dc8","ui_kits/inspector/RunDetail.jsx":"fc20d9cc0c45","ui_kits/inspector/Shell.jsx":"d12e042c1ab5","ui_kits/inspector/data.js":"8b901fdbb1ae","ui_kits/site/Site.jsx":"a4027152321d"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.WoofDesignSystem_3b6aec = window.WoofDesignSystem_3b6aec || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function Badge({
  children,
  tone = "neutral",
  mono = true,
  style
}) {
  const c = tone === "accent" ? {
    bg: "var(--accent-subtle)",
    fg: "var(--accent-text)"
  } : {
    bg: "var(--bg-raised)",
    fg: "var(--text-secondary)"
  };
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      height: 18,
      padding: "0 6px",
      borderRadius: "var(--radius-sm)",
      border: "1px solid " + (tone === "accent" ? "transparent" : "var(--border-subtle)"),
      background: c.bg,
      color: c.fg,
      font: mono ? "var(--type-mono-sm)" : "var(--type-label)",
      fontSize: 11,
      lineHeight: 1,
      whiteSpace: "nowrap",
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function Card({
  title,
  actions,
  children,
  padding = 12,
  style,
  bodyStyle
}) {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: "var(--bg-surface)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
      ...style
    }
  }, (title || actions) && /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      minHeight: 32,
      padding: "0 12px",
      borderBottom: "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-label)",
      letterSpacing: "var(--tracking-wide)",
      textTransform: "uppercase",
      color: "var(--text-muted)"
    }
  }, title), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 4
    }
  }, actions)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding,
      ...bodyStyle
    }
  }, children));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Chip.jsx
try { (() => {
/** Status chip. state maps to the state color; tone overrides. */
const MAP = {
  pass: "pass",
  completed: "pass",
  accepted: "pass",
  alive: "pass",
  delivered: "pass",
  fail: "fail",
  failed: "fail",
  rejected: "fail",
  reject: "fail",
  corrupt: "fail",
  blocked: "blocked",
  attention: "blocked",
  exhausted: "blocked",
  lost: "lost",
  exited: "lost",
  abandoned: "lost",
  cancelled: "lost",
  superseded: "lost",
  unhosted: "lost",
  idle: "idle",
  created: "idle",
  done: "pass",
  working: "working",
  running: "working",
  starting: "working",
  open: "working",
  ambiguous: "blocked"
};
function Chip({
  state,
  children,
  tone,
  dot = true,
  pulse,
  size = "md",
  style
}) {
  const t = tone || MAP[state] || "idle";
  const live = pulse ?? t === "working";
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: size === "sm" ? 18 : 22,
      padding: size === "sm" ? "0 6px" : "0 8px",
      borderRadius: "var(--radius-pill)",
      background: "var(--state-" + t + "-subtle)",
      color: "var(--state-" + t + ")",
      font: "var(--type-mono-sm)",
      fontSize: size === "sm" ? 11 : 12,
      fontWeight: 500,
      whiteSpace: "nowrap",
      lineHeight: 1,
      ...style
    }
  }, dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: "50%",
      background: "currentColor",
      animation: live ? "woofPulse 1.2s infinite" : "none"
    }
  }), children ?? state, /*#__PURE__*/React.createElement("style", null, "@keyframes woofPulse{50%{opacity:.25}}"));
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Chip.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Lucide icon paths (ISC), 1.5px stroke. Substitute set — the repo ships no icons.
const ICON_PATHS = {
  "play": "<polygon points=\"6 3 20 12 6 21 6 3\"/>",
  "square": "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"1\"/>",
  "x": "<path d=\"M18 6 6 18M6 6l12 12\"/>",
  "check": "<path d=\"M20 6 9 17l-5-5\"/>",
  "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\"/><path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>",
  "chevronDown": "<path d=\"m6 9 6 6 6-6\"/>",
  "chevronRight": "<path d=\"m9 18 6-6-6-6\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/><path d=\"m21 21-4.3-4.3\"/>",
  "refresh": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/><path d=\"M21 3v5h-5\"/><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/><path d=\"M8 16H3v5\"/>",
  "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41\"/>",
  "moon": "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/>",
  "file": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/>",
  "terminal": "<polyline points=\"4 17 10 11 4 5\"/><line x1=\"12\" x2=\"20\" y1=\"19\" y2=\"19\"/>",
  "externalLink": "<path d=\"M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/>",
  "alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z\"/><path d=\"M12 9v4M12 17h.01\"/>",
  "info": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4M12 8h.01\"/>",
  "menu": "<path d=\"M4 6h16M4 12h16M4 18h16\"/>",
  "github": "<path d=\"M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4\"/><path d=\"M9 18c-4.51 2-5-2-7-2\"/>",
  "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/>",
  "hash": "<line x1=\"4\" x2=\"20\" y1=\"9\" y2=\"9\"/><line x1=\"4\" x2=\"20\" y1=\"15\" y2=\"15\"/><line x1=\"10\" x2=\"8\" y1=\"3\" y2=\"21\"/><line x1=\"16\" x2=\"14\" y1=\"3\" y2=\"21\"/>",
  "arrowRight": "<path d=\"M5 12h14M12 5l7 7-7 7\"/>",
  "dot": "<circle cx=\"12\" cy=\"12\" r=\"3\" fill=\"currentColor\" stroke=\"none\"/>"
};
function Icon({
  name,
  size = 16,
  color = "currentColor",
  strokeWidth = 1.5,
  style,
  ...rest
}) {
  const d = ICON_PATHS[name] || "";
  return /*#__PURE__*/React.createElement("svg", _extends({
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: strokeWidth,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    style: {
      flex: "none",
      display: "inline-block",
      verticalAlign: "middle",
      ...style
    },
    dangerouslySetInnerHTML: {
      __html: d
    }
  }, rest));
}
Object.assign(__ds_scope, { ICON_PATHS, Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState
} = React;
const V = {
  primary: {
    bg: "var(--accent)",
    fg: "var(--on-accent)",
    bd: "var(--accent)",
    hov: "var(--accent-hover)",
    act: "var(--accent-active)"
  },
  secondary: {
    bg: "var(--bg-raised)",
    fg: "var(--text-primary)",
    bd: "var(--border-default)",
    hov: "var(--bg-hover)",
    act: "var(--bg-active)"
  },
  ghost: {
    bg: "transparent",
    fg: "var(--text-secondary)",
    bd: "transparent",
    hov: "var(--bg-hover)",
    act: "var(--bg-active)"
  },
  danger: {
    bg: "var(--state-fail-subtle)",
    fg: "var(--state-fail)",
    bd: "transparent",
    hov: "var(--state-fail-subtle)",
    act: "var(--state-fail-subtle)"
  }
};
function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  disabled,
  loading,
  children,
  style,
  onClick,
  type = "button",
  ...rest
}) {
  const [h, setH] = useState(false),
    [a, setA] = useState(false);
  const v = V[variant] || V.secondary;
  const height = size === "lg" ? "var(--control-height-lg)" : size === "sm" ? "24px" : "var(--control-height)";
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled || loading,
    onClick: onClick,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => {
      setH(false);
      setA(false);
    },
    onMouseDown: () => setA(true),
    onMouseUp: () => setA(false),
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      height,
      padding: size === "lg" ? "0 16px" : size === "sm" ? "0 8px" : "0 12px",
      borderRadius: "var(--radius-md)",
      border: "1px solid " + v.bd,
      background: a ? v.act : h ? v.hov : v.bg,
      color: v.fg,
      font: size === "lg" ? "var(--type-body)" : "var(--type-small)",
      fontWeight: 500,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? .45 : 1,
      transition: "background var(--duration-fast)",
      whiteSpace: "nowrap",
      ...style
    }
  }, rest), icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === "sm" ? 12 : 14
  }), loading ? "…" : children, iconRight && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: iconRight,
    size: size === "sm" ? 12 : 14
  }));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Checkbox.jsx
try { (() => {
function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  style
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? .45 : 1,
      font: "var(--type-small)",
      color: "var(--text-primary)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: checked,
    onChange: onChange,
    disabled: disabled,
    style: {
      position: "absolute",
      opacity: 0,
      width: 0,
      height: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 14,
      borderRadius: "var(--radius-sm)",
      border: "1px solid " + (checked ? "var(--accent)" : "var(--border-strong)"),
      background: checked ? "var(--accent)" : "var(--bg-inset)",
      display: "grid",
      placeItems: "center",
      transition: "background var(--duration-fast)"
    }
  }, checked && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "check",
    size: 10,
    color: "var(--on-accent)",
    strokeWidth: 2.5
  })), label);
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/core/Hash.jsx
try { (() => {
const {
  useState
} = React;
function Hash({
  value,
  length = 12,
  copy = true,
  prefix,
  style
}) {
  const [ok, setOk] = useState(false);
  const short = value ? value.slice(0, length) : "—";
  const doCopy = e => {
    e.stopPropagation();
    if (navigator.clipboard && value) navigator.clipboard.writeText(value);
    setOk(true);
    setTimeout(() => setOk(false), 1200);
  };
  return /*#__PURE__*/React.createElement("span", {
    title: value,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      font: "var(--type-mono-sm)",
      color: "var(--text-secondary)",
      ...style
    }
  }, prefix && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-muted)"
    }
  }, prefix), /*#__PURE__*/React.createElement("span", null, short, value && value.length > length ? "…" : ""), copy && value && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: doCopy,
    "aria-label": "Copy",
    style: {
      all: "unset",
      display: "grid",
      placeItems: "center",
      width: 16,
      height: 16,
      cursor: "pointer",
      color: ok ? "var(--state-pass)" : "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: ok ? "check" : "copy",
    size: 11
  })));
}
Object.assign(__ds_scope, { Hash });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Hash.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
const {
  useState
} = React;
function IconButton({
  icon,
  label,
  size = "md",
  active,
  disabled,
  onClick,
  style
}) {
  const [h, setH] = useState(false);
  const s = size === "sm" ? 24 : 28;
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": label,
    title: label,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: () => setH(true),
    onMouseLeave: () => setH(false),
    style: {
      width: s,
      height: s,
      display: "inline-grid",
      placeItems: "center",
      borderRadius: "var(--radius-md)",
      border: "1px solid transparent",
      background: active ? "var(--accent-subtle)" : h ? "var(--bg-hover)" : "transparent",
      color: active ? "var(--accent-text)" : "var(--text-secondary)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? .45 : 1,
      transition: "background var(--duration-fast)",
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: size === "sm" ? 14 : 16
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Dialog.jsx
try { (() => {
function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
  width = 440,
  inline
}) {
  if (!open) return null;
  const box = /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    style: {
      width,
      maxWidth: "100%",
      background: "var(--bg-surface)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      boxShadow: "var(--shadow-2)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 12px 12px 16px",
      borderBottom: "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-heading)",
      color: "var(--text-primary)"
    }
  }, title), /*#__PURE__*/React.createElement(__ds_scope.IconButton, {
    icon: "x",
    label: "Close",
    onClick: onClose
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      font: "var(--type-body)",
      color: "var(--text-secondary)"
    }
  }, children), actions && /*#__PURE__*/React.createElement("footer", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 8,
      padding: "12px 16px",
      borderTop: "1px solid var(--border-subtle)"
    }
  }, actions));
  if (inline) return box;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,.5)",
      display: "grid",
      placeItems: "center",
      zIndex: "var(--z-overlay)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation()
  }, box));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState
} = React;
function Input({
  value,
  defaultValue,
  onChange,
  placeholder,
  mono,
  icon,
  invalid,
  disabled,
  width,
  size = "md",
  label,
  hint,
  style,
  ...rest
}) {
  const [f, setF] = useState(false);
  const box = /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      height: size === "lg" ? "var(--control-height-lg)" : "var(--control-height)",
      padding: "0 10px",
      width: width || "100%",
      borderRadius: "var(--radius-md)",
      border: "1px solid " + (invalid ? "var(--state-fail)" : f ? "var(--accent-ring)" : "var(--border-default)"),
      background: "var(--bg-inset)",
      color: "var(--text-primary)",
      boxShadow: f ? "var(--focus-ring)" : "none",
      opacity: disabled ? .45 : 1,
      transition: "box-shadow var(--duration-fast)"
    }
  }, icon && /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 14,
    color: "var(--text-muted)"
  }), /*#__PURE__*/React.createElement("input", _extends({
    value: value,
    defaultValue: defaultValue,
    onChange: onChange,
    placeholder: placeholder,
    disabled: disabled,
    onFocus: () => setF(true),
    onBlur: () => setF(false),
    style: {
      all: "unset",
      flex: 1,
      minWidth: 0,
      font: mono ? "var(--type-mono-sm)" : "var(--type-small)",
      color: "inherit"
    }
  }, rest)));
  if (!label && !hint) return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      width: width || "100%",
      ...style
    }
  }, box);
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "grid",
      gap: 6,
      width: width || "100%",
      ...style
    }
  }, label && /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-small)",
      color: "var(--text-secondary)"
    }
  }, label), box, hint && /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-sm)",
      color: invalid ? "var(--state-fail)" : "var(--text-muted)"
    }
  }, hint));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/JournalLine.jsx
try { (() => {
const FAMILY = t => t.startsWith("gate.") ? "pass" : t === "submission.rejected" ? "fail" : t === "run.blocked" ? "blocked" : t === "run.terminated" ? "lost" : t.startsWith("run.") || t.startsWith("agent.") ? "working" : null;
/** One journal record: seq ts type subject data */
function JournalLine({
  seq,
  ts,
  type,
  subject,
  data,
  decision,
  selected,
  onClick,
  style
}) {
  let fam = FAMILY(type);
  if (type === "gate.recorded" && decision === "reject") fam = "fail";
  if (type === "run.terminated" && data && data.outcome === "completed") fam = "pass";
  if (type === "run.terminated" && data && data.outcome === "failed") fam = "fail";
  const subj = subject ? [subject.agentId, subject.stageId && subject.stageId + " v" + subject.visit + " a" + subject.attempt].filter(Boolean).join(" · ") : "";
  const t = ts ? ts.slice(11, 23) : "";
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: "grid",
      gridTemplateColumns: "40px 96px 180px minmax(0,1fr)",
      gap: 12,
      alignItems: "baseline",
      padding: "3px 12px",
      font: "var(--type-mono-sm)",
      lineHeight: "20px",
      background: selected ? "var(--accent-subtle)" : "transparent",
      boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
      cursor: onClick ? "pointer" : "default",
      ...style
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)",
      textAlign: "right"
    }
  }, seq), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-muted)"
    }
  }, t), /*#__PURE__*/React.createElement("span", {
    style: {
      color: fam ? "var(--state-" + fam + ")" : "var(--text-primary)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, type), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-secondary)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, subj, data && Object.keys(data).length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-muted)"
    }
  }, (subj ? "  " : "") + JSON.stringify(data))));
}
Object.assign(__ds_scope, { JournalLine });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/JournalLine.jsx", error: String((e && e.message) || e) }); }

// components/core/KeyValue.jsx
try { (() => {
/** items: [{k, v, mono}] */
function KeyValue({
  items = [],
  columns = 1,
  labelWidth = 140,
  style
}) {
  return /*#__PURE__*/React.createElement("dl", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(" + columns + ", minmax(0,1fr))",
      gap: "6px 24px",
      margin: 0,
      ...style
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: labelWidth + "px minmax(0,1fr)",
      gap: 12,
      alignItems: "baseline",
      minHeight: 20
    }
  }, /*#__PURE__*/React.createElement("dt", {
    style: {
      font: "var(--type-small)",
      color: "var(--text-muted)",
      margin: 0
    }
  }, it.k), /*#__PURE__*/React.createElement("dd", {
    style: {
      margin: 0,
      font: it.mono === false ? "var(--type-small)" : "var(--type-mono-sm)",
      color: "var(--text-primary)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    }
  }, it.v))));
}
Object.assign(__ds_scope, { KeyValue });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/KeyValue.jsx", error: String((e && e.message) || e) }); }

// components/core/Logo.jsx
try { (() => {
/** Woof mark. variant: "mark" (auto lavender/charcoal via theme) | "tile". Set base to the path of assets/brand relative to the page. */
function Logo({
  size = 32,
  variant = "mark",
  theme,
  base = "assets/brand",
  withName = false,
  version,
  style
}) {
  const isLight = theme === "light" || theme == null && typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light";
  const file = variant === "tile" ? isLight ? "tile-light.svg" : "tile-dark.svg" : isLight ? "woof-ink.svg" : "woof.svg";
  const img = /*#__PURE__*/React.createElement("img", {
    src: base + "/" + file,
    alt: "Woof",
    width: size,
    height: size,
    style: {
      display: "block",
      borderRadius: variant === "tile" ? size * 0.0625 : 0
    }
  });
  if (!withName) return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      ...style
    }
  }, img);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: Math.round(size * 0.3),
      ...style
    }
  }, img, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-heading)",
      fontSize: Math.max(14, Math.round(size * 0.5)),
      color: "var(--text-primary)"
    }
  }, "Woof"), version && /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)"
    }
  }, version));
}
Object.assign(__ds_scope, { Logo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Logo.jsx", error: String((e && e.message) || e) }); }

// components/core/Select.jsx
try { (() => {
function Select({
  value,
  onChange,
  options = [],
  mono,
  disabled,
  width,
  style
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      display: "inline-flex",
      width: width || "auto",
      ...style
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: value,
    onChange: onChange,
    disabled: disabled,
    style: {
      appearance: "none",
      WebkitAppearance: "none",
      height: "var(--control-height)",
      padding: "0 28px 0 10px",
      width: "100%",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border-default)",
      background: "var(--bg-raised)",
      color: "var(--text-primary)",
      font: mono ? "var(--type-mono-sm)" : "var(--type-small)",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? .45 : 1
    }
  }, options.map(o => typeof o === "string" ? /*#__PURE__*/React.createElement("option", {
    key: o,
    value: o
  }, o) : /*#__PURE__*/React.createElement("option", {
    key: o.value,
    value: o.value
  }, o.label))), /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "chevronDown",
    size: 14,
    color: "var(--text-muted)",
    style: {
      position: "absolute",
      right: 8,
      top: "50%",
      transform: "translateY(-50%)",
      pointerEvents: "none"
    }
  }));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Select.jsx", error: String((e && e.message) || e) }); }

// components/core/Switch.jsx
try { (() => {
function Switch({
  checked,
  onChange,
  label,
  disabled,
  style
}) {
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? .45 : 1,
      font: "var(--type-small)",
      color: "var(--text-primary)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    role: "switch",
    checked: checked,
    onChange: onChange,
    disabled: disabled,
    style: {
      position: "absolute",
      opacity: 0,
      width: 0,
      height: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 28,
      height: 16,
      borderRadius: 999,
      background: checked ? "var(--accent)" : "var(--border-strong)",
      position: "relative",
      transition: "background var(--duration-base)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 2,
      left: checked ? 14 : 2,
      width: 12,
      height: 12,
      borderRadius: "50%",
      background: checked ? "var(--on-accent)" : "var(--bg-surface)",
      transition: "left var(--duration-base) var(--ease-out)"
    }
  })), label);
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Switch.jsx", error: String((e && e.message) || e) }); }

// components/core/Table.jsx
try { (() => {
/** columns: {key,label,align,width,mono,render} */
function Table({
  columns = [],
  rows = [],
  rowKey = "id",
  selected,
  onSelect,
  dense,
  empty = "Nothing to show.",
  style
}) {
  const h = dense ? "var(--row-height-dense)" : "var(--row-height)";
  return /*#__PURE__*/React.createElement("table", {
    style: {
      width: "100%",
      borderCollapse: "collapse",
      font: "var(--type-small)",
      ...style
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, columns.map(c => /*#__PURE__*/React.createElement("th", {
    key: c.key,
    style: {
      height: h,
      padding: "0 12px",
      textAlign: c.align || "left",
      width: c.width,
      font: "var(--type-label)",
      letterSpacing: "var(--tracking-wide)",
      textTransform: "uppercase",
      color: "var(--text-muted)",
      borderBottom: "1px solid var(--border-subtle)",
      whiteSpace: "nowrap"
    }
  }, c.label)))), /*#__PURE__*/React.createElement("tbody", null, rows.length === 0 && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: columns.length,
    style: {
      padding: "16px 12px",
      color: "var(--text-muted)",
      font: "var(--type-small)"
    }
  }, empty)), rows.map((r, i) => {
    const k = r[rowKey] ?? i;
    const on = selected != null && selected === k;
    return /*#__PURE__*/React.createElement("tr", {
      key: k,
      onClick: onSelect ? () => onSelect(k, r) : undefined,
      style: {
        cursor: onSelect ? "pointer" : "default",
        background: on ? "var(--accent-subtle)" : "transparent",
        boxShadow: on ? "inset 2px 0 0 var(--accent)" : "none"
      },
      onMouseEnter: e => {
        if (!on) e.currentTarget.style.background = "var(--bg-hover)";
      },
      onMouseLeave: e => {
        if (!on) e.currentTarget.style.background = "transparent";
      }
    }, columns.map(c => /*#__PURE__*/React.createElement("td", {
      key: c.key,
      style: {
        height: h,
        padding: "0 12px",
        textAlign: c.align || "left",
        font: c.mono ? "var(--type-mono-sm)" : "var(--type-small)",
        fontVariantNumeric: "tabular-nums",
        color: "var(--text-primary)",
        borderBottom: "1px solid var(--border-subtle)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: c.maxWidth
      }
    }, c.render ? c.render(r) : r[c.key])));
  })));
}
Object.assign(__ds_scope, { Table });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Table.jsx", error: String((e && e.message) || e) }); }

// components/core/Tabs.jsx
try { (() => {
function Tabs({
  tabs = [],
  value,
  onChange,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    style: {
      display: "flex",
      gap: 2,
      borderBottom: "1px solid var(--border-subtle)",
      ...style
    }
  }, tabs.map(t => {
    const o = typeof t === "string" ? {
      id: t,
      label: t
    } : t;
    const on = o.id === value;
    return /*#__PURE__*/React.createElement("button", {
      key: o.id,
      role: "tab",
      "aria-selected": on,
      type: "button",
      onClick: () => onChange && onChange(o.id),
      style: {
        all: "unset",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 32,
        padding: "0 10px",
        marginBottom: -1,
        font: "var(--type-small)",
        fontWeight: 500,
        color: on ? "var(--text-primary)" : "var(--text-muted)",
        borderBottom: "2px solid " + (on ? "var(--accent)" : "transparent"),
        cursor: "pointer",
        transition: "color var(--duration-fast)"
      }
    }, o.label, o.count != null && /*#__PURE__*/React.createElement(__ds_scope.Badge, null, o.count));
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function Tag({
  children,
  onRemove,
  style
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      height: 22,
      padding: "0 4px 0 8px",
      borderRadius: "var(--radius-sm)",
      border: "1px solid var(--border-default)",
      background: "var(--bg-surface)",
      color: "var(--text-primary)",
      font: "var(--type-mono-sm)",
      ...style
    }
  }, children, onRemove && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onRemove,
    "aria-label": "Remove",
    style: {
      all: "unset",
      display: "grid",
      placeItems: "center",
      width: 16,
      height: 16,
      borderRadius: 3,
      cursor: "pointer",
      color: "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 11
  })));
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/core/Timeline.jsx
try { (() => {
/** items: [{stageId, visit, attempts:[{attempt, status, cause, agentId, verdict, at}], round}] */
function Timeline({
  items = [],
  onSelect,
  selected,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gap: 0,
      ...style
    }
  }, items.map((v, i) => {
    const last = i === items.length - 1;
    return /*#__PURE__*/React.createElement("div", {
      key: v.stageId + v.visit,
      style: {
        display: "grid",
        gridTemplateColumns: "20px minmax(0,1fr)",
        gap: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        position: "absolute",
        left: 6,
        top: 10,
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: v.status === "open" ? "var(--state-working)" : v.status === "accepted" ? "var(--state-pass)" : v.status === "rejected" ? "var(--state-fail)" : "var(--border-strong)",
        boxShadow: "0 0 0 2px var(--bg-surface)"
      }
    }), !last && /*#__PURE__*/React.createElement("span", {
      style: {
        position: "absolute",
        left: 9.5,
        top: 18,
        bottom: -4,
        width: 1,
        background: "var(--border-default)"
      }
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        paddingBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 28
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        font: "var(--type-mono)",
        fontWeight: 500,
        color: "var(--text-primary)"
      }
    }, v.stageId, " ", /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--text-muted)"
      }
    }, "v", v.visit)), v.round != null && /*#__PURE__*/React.createElement("span", {
      style: {
        font: "var(--type-mono-sm)",
        color: "var(--text-muted)"
      }
    }, "r", v.round), v.status && /*#__PURE__*/React.createElement(__ds_scope.Chip, {
      size: "sm",
      state: v.status
    })), (v.attempts || []).map(a => {
      const k = v.stageId + "/" + v.visit + "/" + a.attempt;
      const on = selected === k;
      return /*#__PURE__*/React.createElement("div", {
        key: k,
        onClick: onSelect ? () => onSelect(k, {
          ...a,
          stageId: v.stageId,
          visit: v.visit
        }) : undefined,
        style: {
          display: "grid",
          gridTemplateColumns: "56px 110px 110px minmax(0,1fr) auto",
          gap: 12,
          alignItems: "center",
          height: 24,
          padding: "0 8px",
          marginLeft: 16,
          borderRadius: "var(--radius-sm)",
          font: "var(--type-mono-sm)",
          background: on ? "var(--accent-subtle)" : "transparent",
          cursor: onSelect ? "pointer" : "default"
        }
      }, /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-secondary)"
        }
      }, "a", a.attempt), /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-muted)"
        }
      }, a.cause), /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-secondary)"
        }
      }, a.agentId), /*#__PURE__*/React.createElement("span", {
        style: {
          color: a.verdict === "pass" ? "var(--state-pass)" : a.verdict === "fail" ? "var(--state-fail)" : "var(--text-muted)"
        }
      }, a.verdict || (a.status === "open" ? "…" : "")), /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-faint)"
        }
      }, a.at));
    })));
  }));
}
Object.assign(__ds_scope, { Timeline });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Timeline.jsx", error: String((e && e.message) || e) }); }

// components/core/Toast.jsx
try { (() => {
function Toast({
  tone = "neutral",
  title,
  detail,
  action,
  onDismiss,
  style
}) {
  const c = tone === "neutral" ? "var(--text-secondary)" : "var(--state-" + tone + ")";
  return /*#__PURE__*/React.createElement("div", {
    role: "status",
    style: {
      display: "grid",
      gridTemplateColumns: "16px minmax(0,1fr) auto",
      gap: 10,
      alignItems: "start",
      width: 360,
      padding: "10px 12px",
      background: "var(--bg-raised)",
      border: "1px solid var(--border-default)",
      borderLeft: "1px solid var(--border-default)",
      borderRadius: "var(--radius-md)",
      boxShadow: "var(--shadow-1)",
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: tone === "fail" || tone === "blocked" ? "alert" : tone === "pass" ? "check" : "info",
    size: 16,
    color: c,
    style: {
      marginTop: 1
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-small)",
      fontWeight: 500,
      color: "var(--text-primary)"
    }
  }, title), detail && /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)",
      marginTop: 2
    }
  }, detail)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4
    }
  }, action, onDismiss && /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: onDismiss,
    "aria-label": "Dismiss",
    style: {
      all: "unset",
      cursor: "pointer",
      color: "var(--text-muted)",
      display: "grid",
      placeItems: "center",
      width: 20,
      height: 20
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Icon, {
    name: "x",
    size: 12
  }))));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Toast.jsx", error: String((e && e.message) || e) }); }

// components/core/Tooltip.jsx
try { (() => {
const {
  useState
} = React;
function Tooltip({
  label,
  children,
  side = "top"
}) {
  const [on, setOn] = useState(false);
  const pos = side === "bottom" ? {
    top: "calc(100% + 6px)"
  } : {
    bottom: "calc(100% + 6px)"
  };
  return /*#__PURE__*/React.createElement("span", {
    onMouseEnter: () => setOn(true),
    onMouseLeave: () => setOn(false),
    style: {
      position: "relative",
      display: "inline-flex"
    }
  }, children, on && /*#__PURE__*/React.createElement("span", {
    role: "tooltip",
    style: {
      position: "absolute",
      left: "50%",
      transform: "translateX(-50%)",
      ...pos,
      padding: "4px 8px",
      background: "var(--charcoal-0)",
      color: "var(--charcoal-8)",
      border: "1px solid var(--charcoal-4)",
      borderRadius: "var(--radius-sm)",
      font: "var(--type-mono-sm)",
      whiteSpace: "nowrap",
      boxShadow: "var(--shadow-1)",
      zIndex: "var(--z-overlay)"
    }
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tooltip.jsx", error: String((e && e.message) || e) }); }

// ui_kits/inspector/RunDetail.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
// Run detail: overview (status, agents, timeline), journal, artifacts.
const DS2 = window.WoofDesignSystem_3b6aec;
const {
  Card,
  Chip,
  Badge,
  KeyValue,
  Hash,
  Timeline,
  Table,
  Tabs,
  JournalLine,
  Switch,
  Button,
  IconButton,
  Icon,
  Tooltip,
  Toast
} = DS2;
const ago = iso => {
  const d = (Date.parse("2026-09-16T20:41:21.000Z") - Date.parse(iso)) / 1000;
  if (d < 60) return Math.round(d) + " s ago";
  if (d < 3600) return Math.round(d / 60) + " min ago";
  if (d < 86400) return Math.round(d / 3600) + " h ago";
  return "yesterday";
};
function StatusBar({
  run
}) {
  const active = run.agents.filter(a => a.active);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-title)",
      color: "var(--text-primary)"
    }
  }, run.runId), /*#__PURE__*/React.createElement(Chip, {
    state: run.status
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)"
    }
  }, "owner"), /*#__PURE__*/React.createElement(Chip, {
    state: run.owner,
    dot: run.owner === "alive",
    pulse: run.owner === "alive"
  }), run.result && /*#__PURE__*/React.createElement(Badge, null, "exit ", run.result.exit), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)"
    }
  }, active.length > 0 ? active.map(a => a.agentId + " → " + a.active).join(" · ") : "no active attempt", " \xB7 updated ", /*#__PURE__*/React.createElement(Tooltip, {
    label: run.updatedAt
  }, /*#__PURE__*/React.createElement("span", null, ago(run.updatedAt)))));
}
function Attention({
  run
}) {
  if (run.blocked) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "16px minmax(0,1fr) auto",
        gap: 12,
        alignItems: "start",
        padding: "10px 12px",
        border: "1px solid var(--state-blocked)",
        borderRadius: "var(--radius-md)",
        background: "var(--state-blocked-subtle)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "alert",
      size: 16,
      color: "var(--state-blocked)",
      style: {
        marginTop: 2
      }
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-small)",
        fontWeight: 500,
        color: "var(--text-primary)"
      }
    }, "Blocked \xB7 ", /*#__PURE__*/React.createElement("code", {
      style: {
        fontSize: 12
      }
    }, run.blocked.reason), " \xB7 ", run.blocked.agentId, " \xB7 since ", ago(run.blocked.since)), /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-small)",
        color: "var(--text-secondary)",
        marginTop: 2
      }
    }, run.blocked.requiredAction), /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-mono-sm)",
        color: "var(--text-muted)",
        marginTop: 4
      }
    }, "woof status --wait exits 9 until resolved. Woof never answers the prompt.")), /*#__PURE__*/React.createElement(Button, {
      size: "sm"
    }, "Mark resolved"));
  }
  if (run.result) {
    const t = run.result.outcome === "completed" ? "pass" : run.result.outcome === "failed" ? "fail" : run.result.outcome === "exhausted" ? "blocked" : "lost";
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        gridTemplateColumns: "16px minmax(0,1fr)",
        gap: 12,
        alignItems: "start",
        padding: "10px 12px",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-surface)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: t === "pass" ? "check" : "info",
      size: 16,
      color: "var(--state-" + t + ")",
      style: {
        marginTop: 2
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-small)",
        color: "var(--text-secondary)"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--text-primary)",
        fontWeight: 500
      }
    }, "Run ", run.result.outcome, "."), " reason ", /*#__PURE__*/React.createElement("code", {
      style: {
        fontSize: 12
      }
    }, run.result.reason), run.result.limit && /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 limit ", /*#__PURE__*/React.createElement("code", {
      style: {
        fontSize: 12
      }
    }, run.result.limit), " reached (", run.rounds, " of ", run.maxRounds, " rounds)"), " \xB7 exit ", run.result.exit, run.owner === "lost" && /*#__PURE__*/React.createElement(React.Fragment, null, " \xB7 owner ", /*#__PURE__*/React.createElement("code", {
      style: {
        fontSize: 12
      }
    }, "lost"), ": the host stopped heartbeating; the journal holds the recorded outcome.")));
  }
  return null;
}
function Overview({
  run,
  selAttempt,
  setSelAttempt
}) {
  const lastGate = run.gates[run.gates.length - 1];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) var(--inspector-width)",
      gap: 16,
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Stage visits",
    actions: /*#__PURE__*/React.createElement("span", {
      style: {
        font: "var(--type-mono-sm)",
        color: "var(--text-muted)"
      }
    }, "round ", run.rounds, " of ", run.maxRounds)
  }, /*#__PURE__*/React.createElement(Timeline, {
    items: run.stages,
    selected: selAttempt,
    onSelect: k => setSelAttempt(k)
  })), /*#__PURE__*/React.createElement(Card, {
    title: "Agents",
    padding: 0
  }, /*#__PURE__*/React.createElement(Table, {
    rows: run.agents,
    rowKey: "agentId",
    columns: [{
      key: "agentId",
      label: "Agent",
      mono: true
    }, {
      key: "role",
      label: "Role",
      render: r => /*#__PURE__*/React.createElement(Badge, {
        mono: false
      }, r.role)
    }, {
      key: "kind",
      label: "Kind · model",
      mono: true,
      render: r => r.kind + " · " + (r.model || "—")
    }, {
      key: "activity",
      label: "Activity",
      render: r => /*#__PURE__*/React.createElement(Chip, {
        size: "sm",
        state: r.activity
      })
    }, {
      key: "active",
      label: "Attempt",
      mono: true,
      render: r => r.active || /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-faint)"
        }
      }, "\u2014")
    }, {
      key: "pane",
      label: "Pane",
      mono: true,
      align: "right",
      render: r => r.pane || /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-faint)"
        }
      }, "closed")
    }]
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Run"
  }, /*#__PURE__*/React.createElement(KeyValue, {
    labelWidth: 96,
    items: [{
      k: "Workflow",
      v: run.workflow.name + "@" + run.workflow.version
    }, {
      k: "Task",
      v: run.task,
      mono: false
    }, {
      k: "Repo",
      v: run.repo
    }, {
      k: "Opened",
      v: run.openedAt.slice(0, 19).replace("T", " ")
    }, {
      k: "Host pane",
      v: run.paneId || "—"
    }, {
      k: "Heartbeat",
      v: run.heartbeatMs + " ms"
    }, {
      k: "Config",
      v: /*#__PURE__*/React.createElement(Hash, {
        prefix: "sha256",
        value: run.configSha
      })
    }]
  })), /*#__PURE__*/React.createElement(Card, {
    title: "Last gate"
  }, lastGate ? /*#__PURE__*/React.createElement(KeyValue, {
    labelWidth: 96,
    items: [{
      k: "Gate",
      v: lastGate.gate
    }, {
      k: "Decision",
      v: /*#__PURE__*/React.createElement(Chip, {
        size: "sm",
        state: lastGate.decision
      })
    }, {
      k: "Reason",
      v: lastGate.reason
    }, {
      k: "Round",
      v: "r" + lastGate.round
    }, {
      k: "At",
      v: lastGate.at.slice(11, 19)
    }]
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-small)",
      color: "var(--text-muted)"
    }
  }, "No gate recorded yet.")), /*#__PURE__*/React.createElement(Card, {
    title: "Counters \xB7 limits"
  }, /*#__PURE__*/React.createElement(KeyValue, {
    labelWidth: 150,
    items: [{
      k: "rounds",
      v: run.counters.rounds + " / " + run.limits.maxRounds
    }, {
      k: "attempts",
      v: run.counters.attempts
    }, {
      k: "formatRepairs",
      v: run.counters.formatRepairs + " / " + run.limits.maxFormatRepairs
    }, {
      k: "rejections",
      v: run.counters.rejections
    }, {
      k: "maxAttemptsPerVisit",
      v: run.limits.maxAttemptsPerVisit
    }, {
      k: "maxVisitsPerStage",
      v: run.limits.maxVisitsPerStage
    }, {
      k: "runTimeoutMs",
      v: run.limits.runTimeoutMs.toLocaleString("en-US").replace(/,/g, " ")
    }, {
      k: "blockedWaitMs",
      v: run.limits.blockedWaitMs.toLocaleString("en-US").replace(/,/g, " ")
    }]
  }))));
}
function Journal({
  run
}) {
  const [follow, setFollow] = React.useState(run.status === "running");
  const [sel, setSel] = React.useState(null);
  const [q, setQ] = React.useState("");
  const ev = run.events.filter(e => !q || e.type.includes(q) || JSON.stringify(e.subject).includes(q));
  const selected = ev.find(e => e.seq === sel);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) var(--inspector-width)",
      gap: 16,
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: /*#__PURE__*/React.createElement("span", null, "journal.jsonl \xB7 ", run.events.length, " records"),
    padding: 0,
    actions: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(DS2.Input, {
      mono: true,
      icon: "search",
      placeholder: "type or subject",
      value: q,
      onChange: e => setQ(e.target.value),
      width: 200,
      style: {
        height: 24
      }
    }), /*#__PURE__*/React.createElement(Switch, {
      checked: follow,
      onChange: e => setFollow(e.target.checked),
      label: "Follow"
    }))
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "40px 96px 180px minmax(0,1fr)",
      gap: 12,
      padding: "6px 12px",
      font: "var(--type-label)",
      letterSpacing: ".04em",
      textTransform: "uppercase",
      color: "var(--text-muted)",
      borderBottom: "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "seq"), /*#__PURE__*/React.createElement("span", null, "ts"), /*#__PURE__*/React.createElement("span", null, "type"), /*#__PURE__*/React.createElement("span", null, "subject \xB7 data")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "4px 0"
    }
  }, ev.map(e => /*#__PURE__*/React.createElement(JournalLine, _extends({
    key: e.seq
  }, e, {
    decision: e.data.decision,
    selected: e.seq === sel,
    onClick: () => setSel(e.seq)
  })))), follow && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "6px 12px",
      borderTop: "1px solid var(--border-subtle)",
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)",
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement(Chip, {
    size: "sm",
    state: "working"
  }, "following"), "cursor ", run.events.length, "@", run.runId.slice(3), " \xB7 tailPending false")), /*#__PURE__*/React.createElement(Card, {
    title: selected ? "record " + selected.seq : "record"
  }, selected ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(KeyValue, {
    labelWidth: 72,
    items: [{
      k: "type",
      v: selected.type
    }, {
      k: "ts",
      v: selected.ts
    }, {
      k: "cursor",
      v: /*#__PURE__*/React.createElement(Hash, {
        value: selected.seq + "@" + run.configSha,
        length: 16
      })
    }]
  }), /*#__PURE__*/React.createElement("pre", {
    style: {
      font: "var(--type-mono-sm)",
      color: "var(--text-secondary)",
      background: "var(--bg-inset)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-sm)",
      padding: 10,
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      margin: 0
    }
  }, JSON.stringify({
    schemaVersion: 1,
    kind: "woof.run.event",
    runId: run.runId,
    seq: selected.seq,
    ts: selected.ts,
    type: selected.type,
    subject: selected.subject,
    data: selected.data
  }, null, 2))) : /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-small)",
      color: "var(--text-muted)"
    }
  }, "Select a record to see the full envelope. One event per journal record; no synthetic events.")));
}
function Artifacts({
  run
}) {
  const [sel, setSel] = React.useState(run.artifacts[0] ? run.artifacts[0].path : null);
  const a = run.artifacts.find(x => x.path === sel);
  const isReview = a && a.path.endsWith("review.md");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) var(--inspector-width)",
      gap: 16,
      alignItems: "start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Card, {
    title: "Accepted artifacts",
    padding: 0,
    actions: /*#__PURE__*/React.createElement(Button, {
      size: "sm",
      variant: "ghost",
      icon: "hash"
    }, "--verify-artifacts")
  }, /*#__PURE__*/React.createElement(Table, {
    rows: run.artifacts,
    rowKey: "path",
    selected: sel,
    onSelect: k => setSel(k),
    empty: /*#__PURE__*/React.createElement("span", null, "No accepted artifacts. ", /*#__PURE__*/React.createElement("code", null, "artifacts.review"), " is non-null only when the outcome is ", /*#__PURE__*/React.createElement("code", null, "completed"), "."),
    columns: [{
      key: "path",
      label: "Path",
      mono: true
    }, {
      key: "stage",
      label: "Attempt",
      mono: true
    }, {
      key: "verdict",
      label: "Verdict",
      render: r => r.verdict ? /*#__PURE__*/React.createElement(Chip, {
        size: "sm",
        state: r.verdict
      }) : /*#__PURE__*/React.createElement("span", {
        style: {
          color: "var(--text-faint)"
        }
      }, "\u2014")
    }, {
      key: "sha256",
      label: "sha256",
      render: r => /*#__PURE__*/React.createElement(Hash, {
        value: r.sha256
      })
    }, {
      key: "verified",
      label: "Integrity",
      render: r => /*#__PURE__*/React.createElement("span", {
        style: {
          font: "var(--type-mono-sm)",
          color: r.verified ? "var(--state-pass)" : "var(--state-fail)"
        }
      }, r.verified ? "unaltered" : "altered")
    }, {
      key: "size",
      label: "Size",
      mono: true,
      align: "right"
    }]
  })), a && isReview && run.review && /*#__PURE__*/React.createElement(Card, {
    title: a.path
  }, /*#__PURE__*/React.createElement("pre", {
    style: {
      font: "var(--type-code-block)",
      margin: 0,
      color: "var(--text-primary)"
    }
  }, run.review.map((l, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      padding: "0 4px",
      background: l.startsWith("- ") ? "var(--diff-del-bg)" : l.startsWith("+ ") ? "var(--diff-add-bg)" : "transparent",
      color: l.startsWith("- ") ? "var(--diff-del-fg)" : l.startsWith("+ ") ? "var(--diff-add-fg)" : l.startsWith("#") ? "var(--text-primary)" : "var(--text-secondary)",
      fontWeight: l.startsWith("#") ? 500 : 400
    }
  }, l || " ")))), run.diff && /*#__PURE__*/React.createElement(Card, {
    title: "repair v1 a1 \xB7 working tree \xB7 src/title-case.mjs",
    padding: 0
  }, /*#__PURE__*/React.createElement("pre", {
    style: {
      font: "var(--type-code-block)",
      margin: 0
    }
  }, run.diff.map(([k, l], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "20px minmax(0,1fr)",
      padding: "0 12px",
      background: k === "add" ? "var(--diff-add-bg)" : k === "del" ? "var(--diff-del-bg)" : "transparent",
      color: k === "add" ? "var(--diff-add-fg)" : k === "del" ? "var(--diff-del-fg)" : "var(--text-secondary)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-faint)"
    }
  }, k === "add" ? "+" : k === "del" ? "-" : " "), /*#__PURE__*/React.createElement("span", null, l)))))), /*#__PURE__*/React.createElement(Card, {
    title: "Receipt"
  }, a ? /*#__PURE__*/React.createElement(KeyValue, {
    labelWidth: 72,
    items: [{
      k: "receipt",
      v: a.receipt
    }, {
      k: "attempt",
      v: a.stage
    }, {
      k: "path",
      v: a.path
    }, {
      k: "sha256",
      v: /*#__PURE__*/React.createElement(Hash, {
        value: a.sha256,
        length: 20
      })
    }, {
      k: "size",
      v: a.size
    }, {
      k: "check",
      v: /*#__PURE__*/React.createElement("span", {
        style: {
          color: a.verified ? "var(--state-pass)" : "var(--state-fail)"
        }
      }, a.verified ? "re-hashed, unaltered" : "altered")
    }]
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-small)",
      color: "var(--text-muted)"
    }
  }, "Nothing selected.")));
}
Object.assign(window, {
  StatusBar,
  Attention,
  Overview,
  Journal,
  Artifacts
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/inspector/RunDetail.jsx", error: String((e && e.message) || e) }); }

// ui_kits/inspector/Shell.jsx
try { (() => {
// Inspector shell: header, runs sidebar, theme toggle.
const DS = window.WoofDesignSystem_3b6aec;
const {
  Logo,
  IconButton,
  Input,
  Chip,
  Badge,
  Button,
  Tag
} = DS;
function Header({
  theme,
  onTheme,
  run,
  onCancel
}) {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      height: 44,
      display: "flex",
      alignItems: "center",
      gap: 16,
      padding: "0 16px",
      borderBottom: "1px solid var(--border-default)",
      background: "var(--bg-surface)",
      position: "sticky",
      top: 0,
      zIndex: "var(--z-sticky)"
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    size: 24,
    withName: true,
    base: "../../assets/brand",
    theme: theme
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)"
    }
  }, "inspector \xB7 read-only \xB7 no journal lock, no Herdr"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), run && run.status !== "completed" && run.status !== "failed" && run.status !== "exhausted" && run.status !== "cancelled" && /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "danger",
    onClick: onCancel
  }, "Cancel run"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "ghost",
    icon: "terminal"
  }, "woof runs --all"), /*#__PURE__*/React.createElement(IconButton, {
    icon: theme === "light" ? "moon" : "sun",
    label: "Toggle theme",
    onClick: onTheme
  }));
}
function RunsSidebar({
  runs,
  selected,
  onSelect,
  filter,
  setFilter
}) {
  const list = runs.filter(r => !filter || r.runId.includes(filter) || r.repo.includes(filter) || r.status.includes(filter));
  const active = list.filter(r => ["running", "blocked", "starting", "created"].includes(r.status));
  const ended = list.filter(r => !active.includes(r));
  const Row = ({
    r
  }) => {
    const on = r.runId === selected;
    return /*#__PURE__*/React.createElement("div", {
      onClick: () => onSelect(r.runId),
      style: {
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto",
        gap: 8,
        padding: "8px 12px 8px 14px",
        cursor: "pointer",
        background: on ? "var(--accent-subtle)" : "transparent",
        boxShadow: on ? "inset 2px 0 0 var(--accent)" : "none",
        borderBottom: "1px solid var(--border-subtle)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-mono-sm)",
        fontWeight: 500,
        color: "var(--text-primary)"
      }
    }, r.runId), /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-small)",
        color: "var(--text-muted)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, r.task), /*#__PURE__*/React.createElement("div", {
      style: {
        font: "var(--type-mono-sm)",
        color: "var(--text-faint)",
        fontSize: 11
      }
    }, r.workflow.name, " \xB7 r", r.rounds, "/", r.maxRounds)), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        gap: 4,
        justifyItems: "end",
        alignContent: "start"
      }
    }, /*#__PURE__*/React.createElement(Chip, {
      size: "sm",
      state: r.status
    }), /*#__PURE__*/React.createElement(Chip, {
      size: "sm",
      state: r.owner,
      dot: false
    })));
  };
  const Sec = ({
    t,
    n
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 12px 4px",
      font: "var(--type-label)",
      letterSpacing: ".04em",
      textTransform: "uppercase",
      color: "var(--text-muted)",
      display: "flex",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", null, t), /*#__PURE__*/React.createElement("span", null, n));
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: "var(--sidebar-width)",
      borderRight: "1px solid var(--border-default)",
      background: "var(--bg-surface)",
      display: "flex",
      flexDirection: "column",
      minHeight: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 8,
      borderBottom: "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement(Input, {
    mono: true,
    icon: "search",
    placeholder: "Filter by id, repo, status",
    value: filter,
    onChange: e => setFilter(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: "auto",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Sec, {
    t: "Active",
    n: active.length
  }), active.map(r => /*#__PURE__*/React.createElement(Row, {
    key: r.runId,
    r: r
  })), active.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "4px 12px 12px",
      font: "var(--type-small)",
      color: "var(--text-muted)"
    }
  }, "No active runs."), /*#__PURE__*/React.createElement(Sec, {
    t: "Ended",
    n: ended.length
  }), ended.map(r => /*#__PURE__*/React.createElement(Row, {
    key: r.runId,
    r: r
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 12px",
      borderTop: "1px solid var(--border-subtle)",
      font: "var(--type-mono-sm)",
      color: "var(--text-faint)",
      fontSize: 11
    }
  }, "~/.woof/runs \xB7 ", runs.length, " runs \xB7 woof v0.1.0"));
}
Object.assign(window, {
  Header,
  RunsSidebar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/inspector/Shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/inspector/data.js
try { (() => {
// Fake run data for the inspector kit. Shapes follow RunSnapshot / RunStatusView / RunEvent.
window.WOOF_DATA = (() => {
  const T = (m, s) => `2026-09-16T20:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.221Z`;
  const runs = [{
    runId: "br-4f2a9c",
    workflow: {
      name: "plan-build-review",
      version: "1"
    },
    status: "running",
    owner: "alive",
    repo: "~/src/slugify",
    task: "Implement titleCase",
    rounds: 2,
    maxRounds: 3,
    openedAt: T(38, 2),
    updatedAt: T(41, 9),
    paneId: "pane-7c1e",
    heartbeatMs: 2000,
    configSha: "9f3c1e7ab2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef",
    agents: [{
      agentId: "planner",
      role: "planner",
      kind: "claude",
      model: "sonnet",
      activity: "done",
      pane: "pane-a01"
    }, {
      agentId: "builder",
      role: "builder",
      kind: "claude",
      model: "sonnet",
      activity: "working",
      pane: "pane-a02",
      active: "repair v1 a1"
    }, {
      agentId: "reviewer",
      role: "reviewer",
      kind: "claude",
      model: "opus",
      activity: "idle",
      pane: "pane-a03"
    }],
    stages: [{
      stageId: "plan",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "planner",
        verdict: null,
        status: "accepted",
        at: "20:38:02"
      }]
    }, {
      stageId: "build",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "superseded",
        at: "20:39:10"
      }, {
        attempt: 2,
        cause: "format_repair",
        agentId: "builder",
        status: "accepted",
        at: "20:40:31"
      }]
    }, {
      stageId: "verify",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "engine",
        verdict: "pass",
        status: "accepted",
        at: "20:40:44"
      }]
    }, {
      stageId: "review",
      visit: 1,
      round: 1,
      status: "rejected",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "reviewer",
        verdict: "fail",
        status: "accepted",
        at: "20:41:07"
      }]
    }, {
      stageId: "repair",
      visit: 1,
      round: 2,
      status: "open",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "open",
        at: "20:41:09"
      }]
    }],
    gates: [{
      gate: "review",
      decision: "reject",
      reason: "verdict fail",
      round: 1,
      at: T(41, 7)
    }],
    blocked: null,
    counters: {
      rounds: 2,
      attempts: 6,
      formatRepairs: 1,
      rejections: 1
    },
    limits: {
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 3,
      maxFormatRepairs: 2,
      runTimeoutMs: 7200000,
      readinessWaitMs: 180000,
      blockedWaitMs: 600000,
      deliveryTimeoutMs: 60000
    },
    events: [{
      seq: 1,
      ts: T(38, 2),
      type: "run.opened",
      subject: {},
      data: {
        runId: "br-4f2a9c",
        workflow: {
          name: "plan-build-review",
          version: "1"
        }
      }
    }, {
      seq: 2,
      ts: T(38, 2),
      type: "agent.assigned",
      subject: {
        agentId: "planner"
      },
      data: {
        role: "planner",
        kind: "claude",
        model: "sonnet"
      }
    }, {
      seq: 3,
      ts: T(38, 2),
      type: "agent.assigned",
      subject: {
        agentId: "builder"
      },
      data: {
        role: "builder",
        kind: "claude",
        model: "sonnet"
      }
    }, {
      seq: 4,
      ts: T(38, 2),
      type: "agent.assigned",
      subject: {
        agentId: "reviewer"
      },
      data: {
        role: "reviewer",
        kind: "claude",
        model: "opus"
      }
    }, {
      seq: 5,
      ts: T(38, 3),
      type: "attempt.opened",
      subject: {
        agentId: "planner",
        stageId: "plan",
        visit: 1,
        attempt: 1
      },
      data: {
        verdicts: []
      }
    }, {
      seq: 6,
      ts: T(38, 4),
      type: "request.dispatched",
      subject: {
        agentId: "planner",
        stageId: "plan",
        visit: 1,
        attempt: 1
      },
      data: {
        delivery: "started",
        reason: "observed_working"
      }
    }, {
      seq: 7,
      ts: T(39, 1),
      type: "submission.accepted",
      subject: {
        agentId: "planner",
        stageId: "plan",
        visit: 1,
        attempt: 1
      },
      data: {
        receiptId: "rcpt-01",
        artifact: {
          path: "artifacts/plan/visit-1/attempt-1/plan.md",
          sha256: "1c9a2f3e4d5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d"
        }
      }
    }, {
      seq: 8,
      ts: T(39, 10),
      type: "attempt.opened",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1
      },
      data: {
        verdicts: []
      }
    }, {
      seq: 9,
      ts: T(39, 11),
      type: "request.dispatched",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1
      },
      data: {
        delivery: "started",
        reason: "observed_working"
      }
    }, {
      seq: 10,
      ts: T(40, 30),
      type: "submission.rejected",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1
      },
      data: {
        reason: "artifact_hash_mismatch"
      }
    }, {
      seq: 11,
      ts: T(40, 31),
      type: "attempt.opened",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 2
      },
      data: {
        cause: "format_repair"
      }
    }, {
      seq: 12,
      ts: T(40, 40),
      type: "submission.accepted",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 2
      },
      data: {
        receiptId: "rcpt-02",
        revision: {
          head: "a1b2c3d",
          tree: "e4f5a6b"
        }
      }
    }, {
      seq: 13,
      ts: T(40, 44),
      type: "gate.recorded",
      subject: {
        stageId: "verify",
        visit: 1,
        attempt: 1
      },
      data: {
        decision: "pass",
        round: 1,
        exitCode: 0
      }
    }, {
      seq: 14,
      ts: T(40, 45),
      type: "attempt.opened",
      subject: {
        agentId: "reviewer",
        stageId: "review",
        visit: 1,
        attempt: 1
      },
      data: {
        verdicts: ["pass", "fail"]
      }
    }, {
      seq: 15,
      ts: T(40, 46),
      type: "request.dispatched",
      subject: {
        agentId: "reviewer",
        stageId: "review",
        visit: 1,
        attempt: 1
      },
      data: {
        delivery: "started",
        reason: "observed_working"
      }
    }, {
      seq: 16,
      ts: T(41, 6),
      type: "submission.accepted",
      subject: {
        agentId: "reviewer",
        stageId: "review",
        visit: 1,
        attempt: 1
      },
      data: {
        receiptId: "rcpt-03",
        verdict: "fail",
        artifact: {
          path: "artifacts/review/visit-1/attempt-1/review.md",
          sha256: "7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e"
        }
      }
    }, {
      seq: 17,
      ts: T(41, 7),
      type: "gate.recorded",
      subject: {
        stageId: "review",
        visit: 1,
        attempt: 1
      },
      data: {
        decision: "reject",
        round: 1,
        verdict: "fail"
      }
    }, {
      seq: 18,
      ts: T(41, 9),
      type: "attempt.opened",
      subject: {
        agentId: "builder",
        stageId: "repair",
        visit: 1,
        attempt: 1
      },
      data: {
        inputs: ["rcpt-01", "rcpt-03"]
      }
    }, {
      seq: 19,
      ts: T(41, 9),
      type: "request.dispatched",
      subject: {
        agentId: "builder",
        stageId: "repair",
        visit: 1,
        attempt: 1
      },
      data: {
        delivery: "started",
        reason: "observed_working"
      }
    }],
    artifacts: [{
      path: "artifacts/plan/visit-1/attempt-1/plan.md",
      sha256: "1c9a2f3e4d5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d",
      size: "2.1 KiB",
      receipt: "rcpt-01",
      stage: "plan v1 a1",
      verified: true
    }, {
      path: "artifacts/review/visit-1/attempt-1/review.md",
      sha256: "7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e",
      size: "1.4 KiB",
      receipt: "rcpt-03",
      stage: "review v1 a1",
      verified: true,
      verdict: "fail"
    }, {
      path: "artifacts/verify/visit-1/attempt-1/check.log",
      sha256: "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f",
      size: "612 B",
      receipt: "engine",
      stage: "verify v1 a1",
      verified: true
    }],
    review: ["# Review — titleCase", "", "Verdict: fail", "", "- `titleCase(\"\")` returns `undefined`; acceptance says an empty string.", "- Words separated by tabs keep their case.", "+ Hyphenated words capitalise each part (nice).", "", "Repair: handle empty input and split on /\\s+/."],
    diff: [["ctx", "export function titleCase(text) {"], ["del", "  return text.split(' ')"], ["add", "  if (text === '') return '';"], ["add", "  return text.split(/\\s+/)"], ["ctx", "    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())"], ["ctx", "    .join(' ');"], ["ctx", "}"]]
  }, {
    runId: "br-e91b03",
    workflow: {
      name: "build-review",
      version: "1"
    },
    status: "blocked",
    owner: "alive",
    repo: "~/src/api-gateway",
    task: "Add rate limiter",
    rounds: 1,
    maxRounds: 3,
    openedAt: T(12, 40),
    updatedAt: T(37, 2),
    paneId: "pane-91aa",
    heartbeatMs: 2000,
    configSha: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66",
    agents: [{
      agentId: "builder",
      role: "builder",
      kind: "claude",
      model: "sonnet",
      activity: "blocked",
      pane: "pane-b01",
      active: "build v1 a1"
    }, {
      agentId: "reviewer",
      role: "reviewer",
      kind: "claude",
      model: "sonnet",
      activity: "idle",
      pane: "pane-b02"
    }],
    stages: [{
      stageId: "build",
      visit: 1,
      round: 1,
      status: "open",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "open",
        at: "20:12:41"
      }]
    }],
    gates: [],
    blocked: {
      agentId: "builder",
      reason: "startup_blocked",
      requiredAction: "Open claude in ~/src/api-gateway once and accept its folder-trust question, then wait again with --allow-blocked.",
      since: T(12, 44)
    },
    counters: {
      rounds: 1,
      attempts: 1,
      formatRepairs: 0,
      rejections: 0
    },
    limits: {
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 3,
      maxFormatRepairs: 2,
      runTimeoutMs: 7200000,
      readinessWaitMs: 180000,
      blockedWaitMs: 600000,
      deliveryTimeoutMs: 60000
    },
    events: [{
      seq: 1,
      ts: T(12, 40),
      type: "run.opened",
      subject: {},
      data: {
        runId: "br-e91b03",
        workflow: {
          name: "build-review",
          version: "1"
        }
      }
    }, {
      seq: 2,
      ts: T(12, 40),
      type: "agent.assigned",
      subject: {
        agentId: "builder"
      },
      data: {
        role: "builder",
        kind: "claude",
        model: "sonnet"
      }
    }, {
      seq: 3,
      ts: T(12, 40),
      type: "agent.assigned",
      subject: {
        agentId: "reviewer"
      },
      data: {
        role: "reviewer",
        kind: "claude",
        model: "sonnet"
      }
    }, {
      seq: 4,
      ts: T(12, 41),
      type: "attempt.opened",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1
      },
      data: {}
    }, {
      seq: 5,
      ts: T(12, 42),
      type: "request.dispatched",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1
      },
      data: {
        delivery: "started",
        reason: "observed_blocked"
      }
    }, {
      seq: 6,
      ts: T(12, 44),
      type: "run.blocked",
      subject: {
        agentId: "builder",
        stageId: "build",
        visit: 1,
        attempt: 1
      },
      data: {
        reason: "startup_blocked"
      }
    }],
    artifacts: [],
    review: null,
    diff: null
  }, {
    runId: "br-77c0de",
    workflow: {
      name: "build-review",
      version: "1"
    },
    status: "completed",
    owner: "exited",
    repo: "~/src/slugify",
    task: "Implement slugify",
    rounds: 1,
    maxRounds: 3,
    openedAt: "2026-09-16T18:02:10.000Z",
    updatedAt: "2026-09-16T18:09:51.000Z",
    paneId: null,
    heartbeatMs: 2000,
    configSha: "9f3c1e7ab2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcdef",
    agents: [{
      agentId: "builder",
      role: "builder",
      kind: "claude",
      model: "sonnet",
      activity: "done",
      pane: null
    }, {
      agentId: "reviewer",
      role: "reviewer",
      kind: "claude",
      model: "sonnet",
      activity: "done",
      pane: null
    }],
    stages: [{
      stageId: "build",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "accepted",
        at: "18:02:11"
      }]
    }, {
      stageId: "verify",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "engine",
        verdict: "pass",
        status: "accepted",
        at: "18:06:30"
      }]
    }, {
      stageId: "review",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "reviewer",
        verdict: "pass",
        status: "accepted",
        at: "18:09:50"
      }]
    }],
    gates: [{
      gate: "review",
      decision: "pass",
      reason: "verdict pass on revision a9c3e1f",
      round: 1,
      at: "2026-09-16T18:09:51.000Z"
    }],
    blocked: null,
    counters: {
      rounds: 1,
      attempts: 3,
      formatRepairs: 0,
      rejections: 0
    },
    limits: {
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 3,
      maxFormatRepairs: 2,
      runTimeoutMs: 7200000,
      readinessWaitMs: 180000,
      blockedWaitMs: 600000,
      deliveryTimeoutMs: 60000
    },
    result: {
      outcome: "completed",
      reason: "gate_passed",
      limit: null,
      exit: 0
    },
    events: [{
      seq: 1,
      ts: "2026-09-16T18:02:10.000Z",
      type: "run.opened",
      subject: {},
      data: {
        runId: "br-77c0de"
      }
    }, {
      seq: 2,
      ts: "2026-09-16T18:09:51.000Z",
      type: "gate.recorded",
      subject: {
        stageId: "review",
        visit: 1,
        attempt: 1
      },
      data: {
        decision: "pass",
        round: 1
      }
    }, {
      seq: 3,
      ts: "2026-09-16T18:09:51.000Z",
      type: "run.terminated",
      subject: {},
      data: {
        outcome: "completed",
        reason: "gate_passed",
        limit: null
      }
    }],
    artifacts: [{
      path: "artifacts/review/visit-1/attempt-1/review.md",
      sha256: "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
      size: "980 B",
      receipt: "rcpt-02",
      stage: "review v1 a1",
      verified: true,
      verdict: "pass"
    }],
    review: ["# Review — slugify", "", "Verdict: pass", "", "All three acceptance criteria hold; tests pass on a9c3e1f."],
    diff: null
  }, {
    runId: "br-1a2b3c",
    workflow: {
      name: "build-review",
      version: "1"
    },
    status: "exhausted",
    owner: "lost",
    repo: "~/src/parser",
    task: "Fix nested quote parsing",
    rounds: 3,
    maxRounds: 3,
    openedAt: "2026-09-15T09:10:00.000Z",
    updatedAt: "2026-09-15T10:48:12.000Z",
    paneId: "pane-0f0f",
    heartbeatMs: 2000,
    configSha: "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66",
    agents: [{
      agentId: "builder",
      role: "builder",
      kind: "claude",
      model: "sonnet",
      activity: "done",
      pane: null
    }, {
      agentId: "reviewer",
      role: "reviewer",
      kind: "claude",
      model: "sonnet",
      activity: "done",
      pane: null
    }],
    stages: [{
      stageId: "build",
      visit: 1,
      round: 1,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "accepted",
        at: "09:10:01"
      }]
    }, {
      stageId: "review",
      visit: 1,
      round: 1,
      status: "rejected",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "reviewer",
        verdict: "fail",
        status: "accepted",
        at: "09:22:40"
      }]
    }, {
      stageId: "repair",
      visit: 1,
      round: 2,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "accepted",
        at: "09:23:00"
      }]
    }, {
      stageId: "review",
      visit: 2,
      round: 2,
      status: "rejected",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "reviewer",
        verdict: "fail",
        status: "accepted",
        at: "09:58:12"
      }]
    }, {
      stageId: "repair",
      visit: 2,
      round: 3,
      status: "accepted",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "builder",
        status: "accepted",
        at: "09:58:30"
      }]
    }, {
      stageId: "review",
      visit: 3,
      round: 3,
      status: "rejected",
      attempts: [{
        attempt: 1,
        cause: "initial",
        agentId: "reviewer",
        verdict: "fail",
        status: "accepted",
        at: "10:48:11"
      }]
    }],
    gates: [{
      gate: "review",
      decision: "reject",
      reason: "verdict fail",
      round: 3,
      at: "2026-09-15T10:48:12.000Z"
    }],
    blocked: null,
    counters: {
      rounds: 3,
      attempts: 6,
      formatRepairs: 0,
      rejections: 0
    },
    limits: {
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 3,
      maxFormatRepairs: 2,
      runTimeoutMs: 7200000,
      readinessWaitMs: 180000,
      blockedWaitMs: 600000,
      deliveryTimeoutMs: 60000
    },
    result: {
      outcome: "exhausted",
      reason: "limit_reached",
      limit: "maxRounds",
      exit: 5
    },
    events: [{
      seq: 1,
      ts: "2026-09-15T09:10:00.000Z",
      type: "run.opened",
      subject: {},
      data: {
        runId: "br-1a2b3c"
      }
    }, {
      seq: 20,
      ts: "2026-09-15T10:48:12.000Z",
      type: "gate.recorded",
      subject: {
        stageId: "review",
        visit: 3,
        attempt: 1
      },
      data: {
        decision: "reject",
        round: 3
      }
    }, {
      seq: 21,
      ts: "2026-09-15T10:48:12.000Z",
      type: "run.terminated",
      subject: {},
      data: {
        outcome: "exhausted",
        reason: "limit_reached",
        limit: "maxRounds"
      }
    }],
    artifacts: [],
    review: null,
    diff: null
  }];
  return {
    runs
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/inspector/data.js", error: String((e && e.message) || e) }); }

// ui_kits/site/Site.jsx
try { (() => {
const {
  Logo,
  Button,
  IconButton,
  Badge,
  Chip,
  Table,
  Tabs,
  Card,
  Icon
} = window.WoofDesignSystem_3b6aec;
function Nav({
  theme,
  onTheme
}) {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      height: 52,
      borderBottom: "1px solid var(--border-subtle)",
      background: "var(--bg-app)",
      position: "sticky",
      top: 0,
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "wrap",
    style: {
      display: "flex",
      alignItems: "center",
      gap: 20,
      height: "100%"
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    size: 28,
    withName: true,
    base: "../../assets/brand",
    theme: theme
  }), /*#__PURE__*/React.createElement(Badge, {
    tone: "accent"
  }, "v0.1.0 pre-release"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), ["Install", "Commands", "Exit codes", "Docs"].map(l => /*#__PURE__*/React.createElement("a", {
    key: l,
    href: "#" + l.toLowerCase().replace(" ", "-"),
    style: {
      font: "var(--type-small)",
      color: "var(--text-secondary)"
    }
  }, l)), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    icon: "github"
  }, "zielus/herdr-woof"), /*#__PURE__*/React.createElement(IconButton, {
    icon: theme === "light" ? "moon" : "sun",
    label: "Toggle theme",
    onClick: onTheme
  })));
}
function Hero() {
  return /*#__PURE__*/React.createElement("section", {
    className: "wrap",
    style: {
      padding: "72px 24px 56px",
      display: "grid",
      gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr)",
      gap: 48,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", {
    style: {
      font: "var(--type-display)",
      letterSpacing: "var(--tracking-tight)",
      margin: "0 0 20px",
      color: "var(--text-primary)",
      textWrap: "pretty"
    }
  }, "Bounded, journaled workflows for coding agents on Herdr."), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-body)",
      fontSize: 16
    }
  }, "Woof runs plan \u2192 build \u2192 verify \u2192 review \u2192 repair across real agent sessions in Herdr panes and hands a structured, hash-verified result back to the caller. Open source. Developer-facing. Not finished."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 24
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "lg",
    icon: "terminal"
  }, "Install the plugin"), /*#__PURE__*/React.createElement(Button, {
    size: "lg",
    iconRight: "arrowRight"
  }, "Read the docs")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 16,
      marginTop: 20,
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "macOS \xB7 Linux"), /*#__PURE__*/React.createElement("span", null, "Node \u2265 22.18"), /*#__PURE__*/React.createElement("span", null, "Herdr \u2265 0.9.0"))), /*#__PURE__*/React.createElement("div", {
    className: "pre",
    style: {
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "p"
  }, "$"), " woof run start --workflow plan-build-review --input input.json"), /*#__PURE__*/React.createElement("div", {
    className: "c"
  }, '{"outcome":"started","runId":"br-4f2a9c","host":{"mode":"herdr-pane"}}'), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 8
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "p"
  }, "$"), " woof status /abs/run --wait"), /*#__PURE__*/React.createElement("div", {
    className: "c"
  }, "running plan v1 a1 r1 \u2026 running build v1 a2 r1 \u2026 running review v1 a1 r1"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--state-fail)"
    }
  }, "gate.recorded"), " ", /*#__PURE__*/React.createElement("span", {
    className: "c"
  }, "review reject r1")), /*#__PURE__*/React.createElement("div", {
    className: "c"
  }, "running repair v1 a1 r2 \u2026 running review v2 a1 r2"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--state-pass)"
    }
  }, "gate.recorded"), " ", /*#__PURE__*/React.createElement("span", {
    className: "c"
  }, "review pass r2")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--state-pass)"
    }
  }, '{"outcome":"completed","limit":null,"counters":{"rounds":2}}')), /*#__PURE__*/React.createElement("div", {
    className: "c"
  }, "# exit 0")));
}
function What() {
  const items = [["Stages, not chat", "Every unit of work is a stage visit with numbered attempts. A reviewer's verdict is a gate; a failing gate routes to repair, never back to plan."], ["Journal is the truth", "An append-only journal.jsonl in the run directory. Snapshots, events and status are derived from it. No second reducer."], ["Hash-verified handoff", "Workers submit a small envelope naming an artifact and its sha256. Woof validates and records; --verify-artifacts re-hashes later."], ["Finite limits", "maxRounds, maxAttemptsPerVisit, maxVisitsPerStage, timeouts. Reaching one ends the run as exhausted with the limit named."], ["Blocking is visible", "An untrusted repo or a prompt waiting on input records run.blocked with a requiredAction. Woof never answers the prompt for you."], ["Read-only inspection", "status, runs, events and config show take no journal lock and never contact Herdr."]];
  return /*#__PURE__*/React.createElement("section", {
    className: "wrap",
    style: {
      padding: "32px 24px 56px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(3,minmax(0,1fr))",
      gap: 16
    }
  }, items.map(([t, d]) => /*#__PURE__*/React.createElement(Card, {
    key: t
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-heading)",
      marginBottom: 6,
      color: "var(--text-primary)"
    }
  }, t), /*#__PURE__*/React.createElement("p", {
    style: {
      font: "var(--type-small)",
      fontSize: 13
    }
  }, d)))));
}
function Install() {
  const [tab, setTab] = React.useState("herdr");
  const code = {
    herdr: [["$", "herdr plugin link ."], ["$", "herdr plugin action list --plugin herdr-woof"], ["#", "doctor · status · start · cancel"]],
    claude: [["$", "claude --plugin-dir plugin/claude"], ["#", "/woof:run <task description>"], ["#", "/woof:run --workflow plan-build-review <task>"]],
    cli: [["$", "bun install --frozen-lockfile && bun run build"], ["$", "bin/woof doctor --json"], ["#", '{"herdr":{"env":true},"claude":{"found":true},"trust":{"status":"trusted"}}']]
  };
  return /*#__PURE__*/React.createElement("section", {
    id: "install",
    className: "wrap",
    style: {
      padding: "32px 24px 56px",
      display: "grid",
      gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)",
      gap: 48
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", null, "Install"), /*#__PURE__*/React.createElement("p", null, "Three surfaces, one product. The Herdr plugin adds four actions; the Claude Code plugin adds ", /*#__PURE__*/React.createElement("code", null, "/woof:run"), "; the CLI is for inspection, debugging and automation."), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: 12,
      font: "var(--type-small)"
    }
  }, "Before the first run, open ", /*#__PURE__*/React.createElement("code", null, "claude"), " in the target repository once and accept its folder-trust question. Woof reports trust status; it never bypasses the dialog.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Tabs, {
    value: tab,
    onChange: setTab,
    tabs: [{
      id: "herdr",
      label: "Herdr plugin"
    }, {
      id: "claude",
      label: "Claude Code plugin"
    }, {
      id: "cli",
      label: "CLI"
    }],
    style: {
      marginBottom: 12
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "pre"
  }, code[tab].map(([k, l], i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: k === "#" ? "c" : ""
  }, k === "$" && /*#__PURE__*/React.createElement("span", {
    className: "p"
  }, "$ "), k === "#" && "# ", l)))));
}
function Commands() {
  const rows = [["woof run start", "Host a workflow run in a Herdr pane; returns once the run is claimed and opened.", "unstable"], ["woof status <run-dir> [--wait]", "Status, owner liveness, active attempts, last gate; --wait polls to a terminal exit code.", "read-only"], ["woof runs", "Runs under ~/.woof/runs or a project; owner reported as unhosted, alive, lost or exited.", "read-only"], ["woof events <run-dir> [--follow]", "One event per journal record, resumable by cursor.", "read-only"], ["woof run show <run-dir>", "Snapshot: agents, per-stage attempts, counters, ambiguous deliveries.", "read-only"], ["woof run cancel <run-dir>", "Records run.terminated{outcome:\"cancelled\"}; the scheduler stops on its next tick.", "unstable"], ["woof config show", "Effective configuration and where each value came from.", "read-only"], ["woof doctor [--json]", "Herdr, Claude Code, folder trust and configuration checks. Always exits 0.", "diagnostic"]].map(([c, d, t]) => ({
    c,
    d,
    t
  }));
  return /*#__PURE__*/React.createElement("section", {
    id: "commands",
    className: "wrap",
    style: {
      padding: "32px 24px 56px"
    }
  }, /*#__PURE__*/React.createElement("h2", null, "Commands"), /*#__PURE__*/React.createElement("p", {
    style: {
      marginBottom: 16
    }
  }, "Progress goes to stderr; stdout prints exactly one JSON line."), /*#__PURE__*/React.createElement(Card, {
    padding: 0
  }, /*#__PURE__*/React.createElement(Table, {
    rows: rows,
    rowKey: "c",
    columns: [{
      key: "c",
      label: "Command",
      mono: true,
      width: 300
    }, {
      key: "d",
      label: "What it does",
      render: r => /*#__PURE__*/React.createElement("span", {
        style: {
          whiteSpace: "normal"
        }
      }, r.d)
    }, {
      key: "t",
      label: "Contract",
      align: "right",
      render: r => /*#__PURE__*/React.createElement(Badge, null, r.t)
    }]
  })));
}
function ExitCodes() {
  const codes = [[0, "completed", "pass"], [1, "usage error", "idle"], [2, "rejected before launch", "fail"], [3, "infrastructure failure", "fail"], [4, "failed", "fail"], [5, "exhausted — a limit ended the run", "blocked"], [6, "cancelled", "lost"], [7, "still running at --timeout-ms", "working"], [8, "owner gone without a recorded outcome (lost / exited)", "lost"], [9, "blocked and needs the operator", "blocked"]];
  return /*#__PURE__*/React.createElement("section", {
    id: "exit-codes",
    className: "wrap",
    style: {
      padding: "32px 24px 72px"
    }
  }, /*#__PURE__*/React.createElement("h2", null, "Exit codes"), /*#__PURE__*/React.createElement("p", {
    style: {
      marginBottom: 16
    }
  }, "A recorded outcome always wins. The last line printed is the status at return time."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(5,minmax(0,1fr))",
      gap: 8
    }
  }, codes.map(([n, d, t]) => /*#__PURE__*/React.createElement("div", {
    key: n,
    style: {
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-md)",
      background: "var(--bg-surface)",
      padding: "10px 12px",
      display: "grid",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--type-mono)",
      fontSize: 20,
      fontWeight: 500,
      color: "var(--text-primary)"
    }
  }, n), /*#__PURE__*/React.createElement(Chip, {
    size: "sm",
    tone: t,
    state: t,
    dot: true,
    pulse: false
  }, t)), /*#__PURE__*/React.createElement("div", {
    style: {
      font: "var(--type-small)",
      color: "var(--text-secondary)"
    }
  }, d)))));
}
function Footer() {
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "wrap",
    style: {
      display: "flex",
      alignItems: "center",
      gap: 16,
      height: 64,
      font: "var(--type-mono-sm)",
      color: "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement(Logo, {
    size: 20,
    base: "../../assets/brand"
  }), /*#__PURE__*/React.createElement("span", null, "Woof v0.1.0 \xB7 Herdr \u2265 0.9.0"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", null, "It does not delegate agents outside a workflow, resume a crashed run, or run parallel work within a run.")));
}
function Site() {
  const [theme, setTheme] = React.useState(localStorage.getItem("woof-theme") || "dark");
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("woof-theme", theme);
  }, [theme]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Nav, {
    theme: theme,
    onTheme: () => setTheme(t => t === "dark" ? "light" : "dark")
  }), /*#__PURE__*/React.createElement(Hero, null), /*#__PURE__*/React.createElement(What, null), /*#__PURE__*/React.createElement(Install, null), /*#__PURE__*/React.createElement(Commands, null), /*#__PURE__*/React.createElement(ExitCodes, null), /*#__PURE__*/React.createElement(Footer, null));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(Site, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/site/Site.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Chip = __ds_scope.Chip;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Hash = __ds_scope.Hash;

__ds_ns.ICON_PATHS = __ds_scope.ICON_PATHS;

__ds_ns.Icon = __ds_scope.Icon;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.JournalLine = __ds_scope.JournalLine;

__ds_ns.KeyValue = __ds_scope.KeyValue;

__ds_ns.Logo = __ds_scope.Logo;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Table = __ds_scope.Table;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Timeline = __ds_scope.Timeline;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

})();
