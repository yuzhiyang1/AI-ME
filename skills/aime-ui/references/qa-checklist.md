# AI-Me UI QA Checklist

Use this before declaring a page complete.

## Product hierarchy

- [ ] The page helps the user make or avoid a real operational decision.
- [ ] Exceptions and approvals are more prominent than routine activity.
- [ ] The primary action is immediately identifiable.
- [ ] Evidence is reachable for consequential AI output.
- [ ] The design does not default to a large chat interface.

## Visual system

- [ ] Existing Multica components were audited and reused where appropriate.
- [ ] All colors, spacing, radii, and shadows come from shared tokens.
- [ ] Purple is restrained and semantic colors communicate state.
- [ ] No glassmorphism, neon, decorative gradients, or agent game cards.
- [ ] No unnecessary nested-card composition.
- [ ] Typography follows the 14px body / 12–13px metadata floor.

## States

- [ ] Loading state exists.
- [ ] Empty state explains why and what happens next.
- [ ] Error state explains failure, retries, and available action.
- [ ] Permission/offline state exists when relevant.
- [ ] Progress is real or indeterminate, never fabricated.

## Interaction

- [ ] One primary action per region.
- [ ] Destructive actions show impact and require confirmation.
- [ ] Approval views show payload, impact, risk, and reversibility.
- [ ] Buttons keep stable width during loading.
- [ ] Drawer/modal focus is managed.

## Accessibility

- [ ] Keyboard navigation works.
- [ ] Focus rings are visible.
- [ ] Icon-only buttons have accessible labels.
- [ ] Status is communicated with text, not only color.
- [ ] Text/background contrast meets WCAG AA.
- [ ] Reduced-motion preferences are respected.

## Responsive QA

- [ ] Checked at 1440px.
- [ ] Checked at 1280px.
- [ ] Long Chinese titles and metadata wrap/truncate correctly.
- [ ] Drawer behavior is appropriate below wide desktop.
- [ ] Kanban horizontal scrolling does not scroll the whole application shell.

## Engineering quality

- [ ] TypeScript is strict and has no avoidable `any`.
- [ ] No new large UI framework was introduced.
- [ ] No large inline style blocks or unexplained `!important`.
- [ ] Relevant typecheck/tests pass.
- [ ] One clear screenshot per page/state is available.
