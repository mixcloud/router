---
'@tanstack/react-router': minor
'@tanstack/router-core': minor
---

Add an experimental `experimental_concurrentRenderFrames` router option that publishes router state to React as one immutable render frame per navigation.

React's `<ViewTransition>` and other transition-only behaviour never engage across a navigation today, because router state reaches components through `useSyncExternalStore`, which React schedules at a synchronous lane from the store's own subscription callback — after the `startTransition` scope has exited. When enabled, the React adapter owns the committed frame in state, stages a successor inside the transition, and acknowledges the exact rendered frame, so an interrupted or superseded navigation cannot settle a newer one.

Default off; with the option unset, the existing granular store subscriptions and selector behaviour are unchanged.
