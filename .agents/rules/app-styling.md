---
trigger: always_on
glob: "**/*.{css,ts,tsx,html,js}"
description: Ensures the extension's user interface is minimal, intuitive, monochrome, and relies on native VS Code themes and Unicode icons.
---

# Extension Styling & UI Design System

To ensure a seamless developer experience, visual harmony, and compatibility with the host environment, all UI elements, webviews, settings views, and popups in the application MUST adhere to these strict minimalism, intuitiveness, and monochrome requirements.

## 1. Core Visual Principles
- **Monochrome & Flat Aesthetic**: 
  - Use a monochrome color palette consisting of neutral grays, blacks, whites, and varying opacities.
  - Do NOT use vibrant colors, gradients, drop shadows, or flashy glow effects (e.g., box-shadow glows).
  - Backgrounds must remain flat or use very subtle, solid borders.
- **Intuitive Interactions**:
  - UI layouts must be standard, clean, and predictable. 
  - Do not introduce complex multi-level layouts or hidden interaction patterns.
  - Keep margins and paddings generous yet compact enough to prevent horizontal scrolling or excessive vertical spacing.
- **Native VS Code Theme Compliance**:
  - Exclusively use official VS Code theme variables (`--vscode-*`) for styling.
  - Test UI in both Dark and Light themes to ensure readability, contrast, and visual consistency.

## 2. Monochrome Iconography (Unicode)
- **Prefer Unicode Characters**:
  - Avoid importing external icon packages, font-based icon libraries (e.g., FontAwesome, Material Icons), or heavy inline/external SVG files unless absolutely necessary.
  - Use clean, standard Unicode symbols/characters for buttons, status indicators, and labels. Recommended symbols include:
    - Add / New: `+`
    - Edit / Modify: `✎` (U+270E)
    - Delete / Remove: `×` (U+00D7) or `⨉` (U+2A09)
    - Search: `⌕` (U+2315)
    - Refresh / Reload: `⟳` (U+27F3) or `↻` (U+21BB)
    - Settings / Gear: `⚙︎` (U+2699 + VS15) or `⛭` (U+26ED)
    - Collapse / Expand: `▲` / `▼` / `◀` / `▶`
    - Check / Complete: `✓` (U+2713) or `✔︎` (U+2714 + VS15)
    - Cancel / Error: `✗` (U+2717) or `✘` (U+2718)
    - Warning: `⚠︎` (U+26A0 + VS15)
    - Menu / Overflow: `⋯` (U+22EF) or `☰` (U+2630)
    - Document / Log: `▤` (U+25A4)
    - Profile / User: `👤︎` (U+1F464 + VS15) or `⍟` (U+235F)
    - Info: `ℹ︎` (U+2139 + VS15) or standard text `i`
- **Enforcing Monochrome Rendering (VS15)**:
  - Many operating systems and browsers render certain Unicode symbols (such as `⚙`, `⚠`, `ℹ`, `👤`) as colorful flat or 3D emojis.
  - To prevent this and force the system to render standard monochrome text glyphs, append the Unicode Variation Selector-15 character (`\uFE0E` in JS, or `&#xFE0E;` in HTML) directly after the symbol.
  - Alternatively, use strictly standard alphanumeric characters, punctuation, or mathematical symbols (like `+`, `x`, `i`) which do not have colorful emoji representations.
- **Icon Sizing & Styling**:
  - Keep Unicode icons inline, matching the font size and color of their surrounding text.
  - Adjust opacity (e.g., `opacity: 0.8` or `opacity: 0.6` for disabled/muted states) to create clean visual hierarchy without introducing additional colors.

## 3. Buttons & Interactive Elements
- **Layout & Shape**:
  - Use rectangular or subtly rounded flat buttons. Avoid highly rounded pill shapes unless standard in VS Code theme.
  - Standardize focus outlines (`outline: 1px solid var(--vscode-focusBorder)`) for keyboard accessibility.
- **State Indicators**:
  - **Hover**: Shift background colors slightly (using `color-mix` with VS Code theme variables or transparency adjustments like `rgba(255, 255, 255, 0.05)`).
  - **Active / Pressed**: Subtle border changes or scaling down by a fraction (e.g., `transform: scale(0.98)`).
  - **Disabled**: Lower opacity to `0.4` or `0.5`, remove pointers, and set `pointer-events: none`.

## 4. Typography & Spacing
- **Font Stack**: Inherit the system font stack directly from the VS Code editor context (`var(--vscode-font-family)` or `var(--vscode-editor-font-family)`).
- **Line Height & Letter Spacing**: Maintain highly readable line-heights (1.4 to 1.5) and avoid custom letter-spacing.
- **Hierarchy**: Limit font sizes to a small set (e.g., 10px, 11px, 12px, 14px) to keep text scaling uniform and predictable.

## 5. Webview & Custom Views Implementation Rules
- Always structure CSS to use `var(--vscode-...)` colors so they adapt automatically to the user's theme.
- Avoid introducing any component or styling library (like TailwindCSS or Bootstrap) that introduces non-standard CSS properties or bloats the bundle size.
- Maintain a clear, simple document structure with semantic HTML (e.g., `<header>`, `<main>`, `<section>`).
